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

import { bytesToBase64 } from "@kuralle-syrinx/realtime";
import { GrokTTSPlugin } from "./tts.js";

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
  onConnection: (socket: WebSocket, requestUrl: string, authHeader: string) => void,
): Promise<string> {
  const server = await new Promise<WebSocketServer>((resolve) => {
    let next: WebSocketServer;
    next = new WebSocketServer({ port: 0 }, () => resolve(next));
  });
  servers.push(server);
  server.on("connection", (socket, request) => {
    const header = request.headers["authorization"];
    onConnection(
      socket,
      request.url ?? "",
      Array.isArray(header) ? header[0] ?? "" : header ?? "",
    );
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address");
  return `ws://127.0.0.1:${address.port}/v1/tts`;
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for Grok TTS test condition");
}

describe("GrokTTSPlugin", () => {
  it("streams text.delta and maps audio.delta to tts.audio", async () => {
    const received: Array<Record<string, unknown>> = [];
    const endpointUrl = await createLocalServer((socket, requestUrl, authHeader) => {
      expect(requestUrl).toContain("voice=eve");
      expect(requestUrl).toContain("codec=pcm");
      expect(requestUrl).toContain("sample_rate=16000");
      expect(authHeader).toBe("Bearer test-xai-key");
      socket.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        received.push(msg);
        if (msg["type"] === "text.delta") {
          socket.send(JSON.stringify({
            type: "audio.delta",
            delta: bytesToBase64(new Uint8Array([1, 2, 3, 4])),
          }));
        }
        if (msg["type"] === "text.done") {
          socket.send(JSON.stringify({ type: "audio.done" }));
        }
      });
    });

    const bus = new PipelineBusImpl();
    const started = bus.start();
    const plugin = new GrokTTSPlugin();
    const audio: TextToSpeechAudioPacket[] = [];
    const ends: TextToSpeechEndPacket[] = [];
    bus.on("tts.audio", (pkt) => {
      audio.push(pkt as TextToSpeechAudioPacket);
    });
    bus.on("tts.end", (pkt) => {
      ends.push(pkt as TextToSpeechEndPacket);
    });

    await plugin.initialize(bus, {
      api_key: "test-xai-key",
      endpoint_url: endpointUrl,
      voice_id: "eve",
      sample_rate: 16000,
    });
    bus.push(Route.Main, {
      kind: "tts.text",
      contextId: "turn-1",
      timestampMs: Date.now(),
      text: "Hello there.",
    });
    bus.push(Route.Main, { kind: "tts.done", contextId: "turn-1", timestampMs: Date.now() });
    await waitForCondition(() => ends.length >= 1);

    expect(received).toEqual([
      expect.objectContaining({ type: "text.delta", delta: "Hello there." }),
      expect.objectContaining({ type: "text.done" }),
    ]);
    expect(audio).toEqual([
      expect.objectContaining({
        contextId: "turn-1",
        sampleRateHz: 16000,
        audio: new Uint8Array([1, 2, 3, 4]),
        provider: expect.objectContaining({ name: "grok", model: "eve" }),
      }),
    ]);
    expect(ends).toEqual([expect.objectContaining({ contextId: "turn-1" })]);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("honors codec and bit_rate overrides on the TTS websocket URL", async () => {
    let requestUrl = "";
    const endpointUrl = await createLocalServer((socket, url) => {
      requestUrl = url;
      socket.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg["type"] === "text.delta") {
          socket.send(JSON.stringify({
            type: "audio.delta",
            delta: bytesToBase64(new Uint8Array([1, 2, 3, 4])),
          }));
        }
        if (msg["type"] === "text.done") {
          socket.send(JSON.stringify({ type: "audio.done" }));
        }
      });
    });

    const bus = new PipelineBusImpl();
    const started = bus.start();
    const plugin = new GrokTTSPlugin();
    const ends: TextToSpeechEndPacket[] = [];
    bus.on("tts.end", (pkt) => {
      ends.push(pkt as TextToSpeechEndPacket);
    });

    await plugin.initialize(bus, {
      api_key: "test-xai-key",
      endpoint_url: endpointUrl,
      voice_id: "ara",
      language: "es",
      codec: "mp3",
      bit_rate: 128000,
      sample_rate: 24000,
    });
    bus.push(Route.Main, {
      kind: "tts.text",
      contextId: "turn-cfg",
      timestampMs: Date.now(),
      text: "Hola.",
    });
    bus.push(Route.Main, { kind: "tts.done", contextId: "turn-cfg", timestampMs: Date.now() });
    await waitForCondition(() => ends.length >= 1 || requestUrl.length > 0);

    expect(requestUrl).toContain("voice=ara");
    expect(requestUrl).toContain("language=es");
    expect(requestUrl).toContain("codec=mp3");
    expect(requestUrl).toContain("sample_rate=24000");
    expect(requestUrl).toContain("bit_rate=128000");

    await plugin.close();
    bus.stop();
    await started;
  });

  it("sends text.clear on interrupt", async () => {
    const received: Array<Record<string, unknown>> = [];
    const endpointUrl = await createLocalServer((socket) => {
      socket.on("message", (data) => {
        received.push(JSON.parse(data.toString()) as Record<string, unknown>);
      });
    });

    const bus = new PipelineBusImpl();
    const started = bus.start();
    const plugin = new GrokTTSPlugin();

    await plugin.initialize(bus, { api_key: "test-xai-key", endpoint_url: endpointUrl });
    bus.push(Route.Main, {
      kind: "tts.text",
      contextId: "turn-x",
      timestampMs: Date.now(),
      text: "Interrupt me.",
    });
    await waitForCondition(() => received.some((m) => m["type"] === "text.delta"));
    bus.push(Route.Critical, { kind: "interrupt.tts", contextId: "turn-x", timestampMs: Date.now() });
    await waitForCondition(() => received.some((m) => m["type"] === "text.clear"));

    expect(received).toEqual([
      expect.objectContaining({ type: "text.delta", delta: "Interrupt me." }),
      expect.objectContaining({ type: "text.clear" }),
    ]);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("emits usage.recorded with stage tts and characters equal to synthesized text length", async () => {
    const text = "Hello there.";
    const endpointUrl = await createLocalServer((socket) => {
      socket.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg["type"] === "text.delta") {
          socket.send(JSON.stringify({
            type: "audio.delta",
            delta: bytesToBase64(new Uint8Array([1, 2, 3, 4])),
          }));
        }
        if (msg["type"] === "text.done") {
          socket.send(JSON.stringify({ type: "audio.done" }));
        }
      });
    });

    const bus = new PipelineBusImpl();
    const started = bus.start();
    const plugin = new GrokTTSPlugin();
    const ends: TextToSpeechEndPacket[] = [];
    const usage: UsageRecordedPacket[] = [];
    bus.on("tts.end", (pkt) => {
      ends.push(pkt as TextToSpeechEndPacket);
    });
    bus.on("usage.recorded", (pkt) => {
      usage.push(pkt as UsageRecordedPacket);
    });

    await plugin.initialize(bus, {
      api_key: "test-xai-key",
      endpoint_url: endpointUrl,
      voice_id: "eve",
      sample_rate: 16000,
    });
    bus.push(Route.Main, {
      kind: "tts.text",
      contextId: "turn-usage",
      timestampMs: Date.now(),
      text,
    });
    bus.push(Route.Main, { kind: "tts.done", contextId: "turn-usage", timestampMs: Date.now() });
    await waitForCondition(() => ends.length >= 1 && usage.length >= 1);

    expect(usage).toEqual([
      expect.objectContaining({
        kind: "usage.recorded",
        contextId: "turn-usage",
        stage: "tts",
        provider: "grok",
        model: "eve",
        characters: text.length,
      }),
    ]);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("does not emit usage.recorded for a cancelled TTS turn", async () => {
    const received: Array<Record<string, unknown>> = [];
    const endpointUrl = await createLocalServer((socket) => {
      socket.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        received.push(msg);
        if (msg["type"] === "text.clear") {
          // Late done after cancel must not bill.
          socket.send(JSON.stringify({ type: "audio.done" }));
        }
      });
    });

    const bus = new PipelineBusImpl();
    const started = bus.start();
    const plugin = new GrokTTSPlugin();
    const usage: UsageRecordedPacket[] = [];
    bus.on("usage.recorded", (pkt) => {
      usage.push(pkt as UsageRecordedPacket);
    });

    await plugin.initialize(bus, { api_key: "test-xai-key", endpoint_url: endpointUrl, voice_id: "eve" });
    bus.push(Route.Main, {
      kind: "tts.text",
      contextId: "turn-cancel",
      timestampMs: Date.now(),
      text: "This will be cancelled.",
    });
    await waitForCondition(() => received.some((m) => m["type"] === "text.delta"));
    bus.push(Route.Critical, {
      kind: "interrupt.tts",
      contextId: "turn-cancel",
      timestampMs: Date.now(),
    });
    await waitForCondition(() => received.some((m) => m["type"] === "text.clear"));
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(usage).toEqual([]);

    await plugin.close();
    bus.stop();
    await started;
  });
});
