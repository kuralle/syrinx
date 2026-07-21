// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import {
  PipelineBusImpl,
  Route,
  type TextToSpeechAudioPacket,
  type TextToSpeechEndPacket,
  type UsageRecordedPacket,
} from "@kuralle-syrinx/core";

import { ElevenLabsTTSPlugin, ElevenLabsWireProtocol } from "./tts.js";
import { attributionKey } from "@kuralle-syrinx/tts-core";

let servers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) client.terminate();
          server.close(() => resolve());
        }),
    ),
  );
});

async function createLocalServer(
  onConnection: (socket: WebSocket, requestUrl: string, apiKeyHeader: string) => void,
): Promise<string> {
  const server = await new Promise<WebSocketServer>((resolve) => {
    let nextServer: WebSocketServer;
    nextServer = new WebSocketServer({ port: 0 }, () => {
      resolve(nextServer);
    });
  });
  servers.push(server);
  server.on("connection", (socket, request) => {
    const header = request.headers["xi-api-key"];
    onConnection(socket, request.url ?? "", Array.isArray(header) ? header[0] ?? "" : header ?? "");
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address");
  return `ws://127.0.0.1:${address.port}/v1/text-to-speech/voice/multi-stream-input`;
}

function startBus(bus: PipelineBusImpl): Promise<void> {
  return bus.start();
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for ElevenLabs TTS test condition");
}

describe("ElevenLabsWireProtocol", () => {
  const protocol = new ElevenLabsWireProtocol({
    modelId: "eleven_flash_v2_5",
    audioFormat: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 },
  });

  it("encodes multi-stream text/flush/cancel/close frames", () => {
    const key = attributionKey("turn-1");
    expect(JSON.parse(String(protocol.encodeText(key, "Hello ")[0]))).toEqual({
      text: "Hello ",
      context_id: "turn-1",
    });
    expect(JSON.parse(String(protocol.encodeFinish("turn-1", [key])[0]))).toEqual({
      context_id: "turn-1",
      flush: true,
    });
    expect(JSON.parse(String(protocol.encodeCancel(key, "turn-1")[0]))).toEqual({
      context_id: "turn-1",
      close_context: true,
    });
    expect(JSON.parse(String(protocol.encodeClose()[0]))).toEqual({ close_socket: true });
  });

  it("decodes base64 audio and final into audio + usage + context_end", () => {
    const key = attributionKey("turn-a");
    protocol.encodeText(key, "Hi");
    const pcm = new Uint8Array([1, 2, 3, 4]);
    const events = protocol.decode(
      JSON.stringify({
        audio: Buffer.from(pcm).toString("base64"),
        contextId: "turn-a",
      }),
      false,
    );
    expect(events).toEqual([
      expect.objectContaining({ type: "audio", key, pcm }),
    ]);

    const done = protocol.decode(JSON.stringify({ isFinal: true, contextId: "turn-a" }), false);
    expect(done).toEqual([
      expect.objectContaining({ type: "sideband", key }),
      expect.objectContaining({ type: "context_end", key }),
    ]);
    const sideband = done[0] as Extract<(typeof done)[number], { type: "sideband" }>;
    expect(sideband.build("turn-a", 1)).toEqual(
      expect.objectContaining({
        kind: "usage.recorded",
        stage: "tts",
        provider: "elevenlabs",
        model: "eleven_flash_v2_5",
        characters: 2,
      }),
    );
  });

  it("does not bill cancelled contexts", () => {
    const key = attributionKey("turn-cancel");
    protocol.encodeText(key, "This will cancel");
    protocol.encodeCancel(key, "turn-cancel");
    const done = protocol.decode(JSON.stringify({ is_final: true, context_id: "turn-cancel" }), false);
    expect(done).toEqual([expect.objectContaining({ type: "context_end", key })]);
  });
});

describe("ElevenLabsTTSPlugin", () => {
  it("streams multi-context frames over xi-api-key auth and emits usage on final", async () => {
    const text = "Hello there.";
    const received: unknown[] = [];
    const endpointUrl = await createLocalServer((socket, requestUrl, apiKeyHeader) => {
      expect(requestUrl).toContain("model_id=");
      expect(requestUrl).toContain("output_format=pcm_16000");
      expect(requestUrl).not.toContain("test-el-key");
      expect(apiKeyHeader).toBe("test-el-key");
      socket.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        received.push(msg);
        if (msg["text"] === text) {
          socket.send(
            JSON.stringify({
              audio: Buffer.from(new Uint8Array([1, 2, 3, 4])).toString("base64"),
              contextId: msg["context_id"],
            }),
          );
        }
        if (msg["flush"] === true) {
          socket.send(JSON.stringify({ isFinal: true, contextId: msg["context_id"] }));
        }
      });
    });

    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new ElevenLabsTTSPlugin();
    const audio: TextToSpeechAudioPacket[] = [];
    const ends: TextToSpeechEndPacket[] = [];
    const usage: UsageRecordedPacket[] = [];
    bus.on("tts.audio", (pkt) => {
      audio.push(pkt as TextToSpeechAudioPacket);
    });
    bus.on("tts.end", (pkt) => {
      ends.push(pkt as TextToSpeechEndPacket);
    });
    bus.on("usage.recorded", (pkt) => {
      usage.push(pkt as UsageRecordedPacket);
    });

    await plugin.initialize(bus, {
      api_key: "test-el-key",
      endpoint_url: endpointUrl,
      voice_id: "voice-test",
      model_id: "eleven_flash_v2_5",
      sample_rate: 16000,
    });
    bus.push(Route.Main, {
      kind: "tts.text",
      contextId: "turn-usage",
      timestampMs: Date.now(),
      text,
    });
    bus.push(Route.Main, {
      kind: "tts.done",
      contextId: "turn-usage",
      timestampMs: Date.now(),
      text,
    });
    await waitForCondition(() => ends.length >= 1 && usage.length >= 1 && audio.length >= 1);

    expect(received).toEqual([
      expect.objectContaining({ text, context_id: "turn-usage" }),
      expect.objectContaining({ context_id: "turn-usage", flush: true }),
    ]);
    expect(audio).toEqual([
      expect.objectContaining({
        contextId: "turn-usage",
        audio: new Uint8Array([1, 2, 3, 4]),
      }),
    ]);
    expect(usage).toEqual([
      expect.objectContaining({
        kind: "usage.recorded",
        contextId: "turn-usage",
        stage: "tts",
        provider: "elevenlabs",
        model: "eleven_flash_v2_5",
        characters: text.length,
      }),
    ]);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("cancels active contexts without billing", async () => {
    const received: unknown[] = [];
    const endpointUrl = await createLocalServer((socket) => {
      socket.on("message", (data) => {
        received.push(JSON.parse(data.toString()));
      });
    });
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new ElevenLabsTTSPlugin();
    const usage: UsageRecordedPacket[] = [];
    bus.on("usage.recorded", (pkt) => {
      usage.push(pkt as UsageRecordedPacket);
    });

    await plugin.initialize(bus, {
      api_key: "test-el-key",
      endpoint_url: endpointUrl,
      voice_id: "voice-test",
      model_id: "eleven_flash_v2_5",
    });
    bus.push(Route.Main, {
      kind: "tts.text",
      contextId: "turn-interrupt",
      timestampMs: Date.now(),
      text: "This will be interrupted.",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    bus.push(Route.Critical, {
      kind: "interrupt.tts",
      contextId: "turn-interrupt",
      timestampMs: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(received).toEqual([
      expect.objectContaining({ context_id: "turn-interrupt", text: "This will be interrupted." }),
      expect.objectContaining({ context_id: "turn-interrupt", close_context: true }),
    ]);
    expect(usage).toEqual([]);

    await plugin.close();
    bus.stop();
    await started;
  });
});
