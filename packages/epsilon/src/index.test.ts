// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import {
  PipelineBusImpl,
  Route,
  type TextToSpeechAudioPacket,
  type TextToSpeechEndPacket,
  type TtsErrorPacket,
} from "@kuralle-syrinx/core";

import {
  EpsilonTTSPlugin,
  buildEpsilonWsUrl,
  parseEpsilonBinaryFrame,
  readRequiredBaseUrl,
} from "./index.js";
import { encodeEpsilonBinaryFrame } from "./binary-frame.js";

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
  onConnection: (socket: WebSocket, requestUrl: string) => void,
): Promise<string> {
  const server = await new Promise<WebSocketServer>((resolve) => {
    let nextServer: WebSocketServer;
    nextServer = new WebSocketServer({ port: 0 }, () => {
      resolve(nextServer);
    });
  });
  servers.push(server);
  server.on("connection", (socket, request) => {
    onConnection(socket, request.url ?? "");
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address");
  return `ws://127.0.0.1:${address.port}`;
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
  throw new Error("Timed out waiting for Epsilon test condition");
}

describe("parseEpsilonBinaryFrame", () => {
  it("parses id length, request_id, and pcm payload", () => {
    const pcm = new Uint8Array([0, 1, 2, 3]);
    const frame = encodeEpsilonBinaryFrame("turn-1:0", pcm);
    expect(parseEpsilonBinaryFrame(frame)).toEqual({
      requestId: "turn-1:0",
      pcm,
    });
  });

  it("rejects truncated binary frames", () => {
    expect(() => parseEpsilonBinaryFrame(new Uint8Array([5, 1, 2]))).toThrow(/truncated request_id/i);
  });
});

describe("readRequiredBaseUrl", () => {
  it("throws when base_url is missing", () => {
    expect(() => readRequiredBaseUrl({ api_key: "test" })).toThrow(/missing required key: base_url/i);
  });

  it("accepts base_url and baseUrl aliases", () => {
    expect(readRequiredBaseUrl({ base_url: "wss://host.example" })).toBe("wss://host.example");
    expect(readRequiredBaseUrl({ baseUrl: "wss://host.example" })).toBe("wss://host.example");
  });
});

describe("buildEpsilonWsUrl", () => {
  it("appends the speech path and api key query param", () => {
    expect(buildEpsilonWsUrl("wss://host.example", "secret-key")).toBe(
      "wss://host.example/v1/audio/speech/ws?key=secret-key",
    );
  });
});

describe("EpsilonTTSPlugin", () => {
  it("streams speak requests over one websocket and routes binary pcm by request_id", async () => {
    const receivedRequests: Array<Record<string, unknown>> = [];
    const baseUrl = await createLocalServer((socket, requestUrl) => {
      expect(requestUrl).toContain("key=test-epsilon-key");
      socket.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        receivedRequests.push(msg);
        if (msg["type"] === "speak") {
          const requestId = msg["request_id"] as string;
          socket.send(JSON.stringify({ type: "started", request_id: requestId }));
          socket.send(encodeEpsilonBinaryFrame(requestId, new Uint8Array([1, 2, 3, 4])), { binary: true });
          socket.send(
            JSON.stringify({
              type: "done",
              request_id: requestId,
              ttfa_ms: 120,
              audio_s: 0.08,
            }),
          );
        }
      });
    });
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new EpsilonTTSPlugin();
    const audio: TextToSpeechAudioPacket[] = [];
    const ends: TextToSpeechEndPacket[] = [];
    bus.on("tts.audio", (pkt) => {
      audio.push(pkt as TextToSpeechAudioPacket);
    });
    bus.on("tts.end", (pkt) => {
      ends.push(pkt as TextToSpeechEndPacket);
    });

    await plugin.initialize(bus, {
      api_key: "test-epsilon-key",
      base_url: baseUrl,
      voice: "sinhala",
    });
    bus.push(Route.Main, {
      kind: "tts.text",
      contextId: "turn-1",
      timestampMs: Date.now(),
      text: "Hello there.",
    });
    bus.push(Route.Main, {
      kind: "tts.done",
      contextId: "turn-1",
      timestampMs: Date.now(),
      text: "Hello there.",
    });
    await waitForCondition(() => receivedRequests.length >= 1 && audio.length >= 1 && ends.length >= 1);

    expect(receivedRequests[0]).toEqual(
      expect.objectContaining({
        type: "speak",
        request_id: "turn-1:0",
        input: "Hello there.",
        voice: "sinhala",
      }),
    );
    expect(audio).toEqual([
      expect.objectContaining({
        contextId: "turn-1",
        audio: new Uint8Array([1, 2, 3, 4]),
        sampleRateHz: 24000,
      }),
    ]);
    expect(ends).toEqual([expect.objectContaining({ contextId: "turn-1" })]);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("cancels active Epsilon requests on TTS interruption", async () => {
    const receivedRequests: Array<Record<string, unknown>> = [];
    const baseUrl = await createLocalServer((socket) => {
      socket.on("message", (data) => {
        receivedRequests.push(JSON.parse(data.toString()) as Record<string, unknown>);
      });
    });
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new EpsilonTTSPlugin();

    await plugin.initialize(bus, {
      api_key: "test-epsilon-key",
      base_url: baseUrl,
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

    expect(receivedRequests).toEqual([
      expect.objectContaining({
        type: "speak",
        request_id: "turn-interrupt:0",
      }),
      {
        type: "cancel",
        request_id: "turn-interrupt:0",
      },
    ]);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("drops late binary audio for cancelled requests", async () => {
    const baseUrl = await createLocalServer((socket) => {
      socket.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg["type"] === "cancel") {
          const requestId = msg["request_id"] as string;
          socket.send(encodeEpsilonBinaryFrame(requestId, new Uint8Array([9, 8, 7, 6])), { binary: true });
          socket.send(JSON.stringify({ type: "cancelled", request_id: requestId }));
        }
      });
    });
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new EpsilonTTSPlugin();
    const audio: TextToSpeechAudioPacket[] = [];
    const ends: TextToSpeechEndPacket[] = [];
    bus.on("tts.audio", (pkt) => {
      audio.push(pkt as TextToSpeechAudioPacket);
    });
    bus.on("tts.end", (pkt) => {
      ends.push(pkt as TextToSpeechEndPacket);
    });

    await plugin.initialize(bus, {
      api_key: "test-epsilon-key",
      base_url: baseUrl,
    });
    bus.push(Route.Main, {
      kind: "tts.text",
      contextId: "turn-cancelled",
      timestampMs: Date.now(),
      text: "This generation will be cancelled.",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    bus.push(Route.Critical, {
      kind: "interrupt.tts",
      contextId: "turn-cancelled",
      timestampMs: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(audio).toEqual([]);
    expect(ends).toEqual([]);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("emits typed TTS errors for provider error frames", async () => {
    const baseUrl = await createLocalServer((socket) => {
      socket.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        socket.send(
          JSON.stringify({
            type: "error",
            request_id: msg["request_id"],
            message: "synthesis failed",
          }),
        );
      });
    });
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new EpsilonTTSPlugin();
    const errors: TtsErrorPacket[] = [];
    bus.on("tts.error", (pkt) => {
      errors.push(pkt as TtsErrorPacket);
    });

    await plugin.initialize(bus, {
      api_key: "test-epsilon-key",
      base_url: baseUrl,
    });
    bus.push(Route.Main, {
      kind: "tts.text",
      contextId: "turn-error",
      timestampMs: Date.now(),
      text: "This will fail.",
    });
    await waitForCondition(() => errors.length >= 1);

    expect(errors).toEqual([
      expect.objectContaining({
        kind: "tts.error",
        contextId: "turn-error",
        component: "tts",
      }),
    ]);
    expect(errors[0]!.cause.message).toContain("synthesis failed");

    await plugin.close();
    bus.stop();
    await started;
  });

  it("rejects unsupported sample rates during initialize", async () => {
    const bus = new PipelineBusImpl();
    const plugin = new EpsilonTTSPlugin();
    await expect(
      plugin.initialize(bus, {
        api_key: "test-epsilon-key",
        base_url: "wss://host.example",
        sample_rate: 16000,
      }),
    ).rejects.toThrow(/only supports sample_rate 24000/i);
  });

  it("sends eos on close", async () => {
    const received: string[] = [];
    const baseUrl = await createLocalServer((socket) => {
      socket.on("message", (data) => {
        received.push(data.toString());
      });
    });
    const bus = new PipelineBusImpl();
    const plugin = new EpsilonTTSPlugin();
    await plugin.initialize(bus, {
      api_key: "test-epsilon-key",
      base_url: baseUrl,
    });
    await plugin.close();
    await waitForCondition(() => received.includes(JSON.stringify({ type: "eos" })));
    expect(received).toContain(JSON.stringify({ type: "eos" }));
  });
});
