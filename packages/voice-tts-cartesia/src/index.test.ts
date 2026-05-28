// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import {
  PipelineBusImpl,
  Route,
  type TextToSpeechAudioPacket,
  type TextToSpeechEndPacket,
  type TtsErrorPacket,
} from "@asyncdot/voice";

import { CartesiaTTSPlugin } from "./index.js";

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

async function createLocalServer(onConnection: (socket: WebSocket, requestUrl: string, apiKeyHeader: string) => void): Promise<string> {
  const server = await new Promise<WebSocketServer>((resolve) => {
    let nextServer: WebSocketServer;
    nextServer = new WebSocketServer({ port: 0 }, () => {
      resolve(nextServer);
    });
  });
  servers.push(server);
  server.on("connection", (socket, request) => {
    const header = request.headers["x-api-key"];
    onConnection(socket, request.url ?? "", Array.isArray(header) ? header[0] ?? "" : header ?? "");
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address");
  return `ws://127.0.0.1:${address.port}/tts/websocket`;
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
  throw new Error("Timed out waiting for Cartesia test condition");
}

describe("CartesiaTTSPlugin", () => {
  it("streams text over one authenticated websocket without leaking the API key in the URL", async () => {
    const receivedRequests: any[] = [];
    const endpointUrl = await createLocalServer((socket, requestUrl, apiKeyHeader) => {
      expect(requestUrl).toContain("cartesia_version=");
      expect(requestUrl).not.toContain("test-cartesia-key");
      expect(apiKeyHeader).toBe("test-cartesia-key");
      socket.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        receivedRequests.push(msg);
        if (msg.transcript === "Hello there.") {
          socket.send(JSON.stringify({
            type: "chunk",
            context_id: msg.context_id,
            data: Buffer.from(new Uint8Array([1, 2, 3, 4])).toString("base64"),
            done: false,
            status_code: 206,
          }));
        }
        if (msg.context_id === "turn-1" && msg.continue === false) {
          socket.send(JSON.stringify({
            type: "done",
            context_id: "turn-1",
            done: true,
            status_code: 206,
          }));
        }
      });
    });
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new CartesiaTTSPlugin();
    const audio: TextToSpeechAudioPacket[] = [];
    const ends: TextToSpeechEndPacket[] = [];
    bus.on("tts.audio", (pkt) => {
      audio.push(pkt as TextToSpeechAudioPacket);
    });
    bus.on("tts.end", (pkt) => {
      ends.push(pkt as TextToSpeechEndPacket);
    });

    await plugin.initialize(bus, {
      api_key: "test-cartesia-key",
      endpoint_url: endpointUrl,
      voice_id: "voice-test",
      model_id: "sonic-test",
      sample_rate: 16000,
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
    await waitForCondition(() => receivedRequests.length >= 2 && audio.length >= 1 && ends.length >= 1);

    expect(receivedRequests).toEqual([
      expect.objectContaining({
        context_id: "turn-1",
        continue: true,
        transcript: "Hello there.",
      }),
      expect.objectContaining({
        context_id: "turn-1",
        continue: false,
        flush: true,
        transcript: "",
      }),
    ]);
    expect(audio).toEqual([
      expect.objectContaining({
        contextId: "turn-1",
        audio: new Uint8Array([1, 2, 3, 4]),
      }),
    ]);
    expect(ends).toEqual([expect.objectContaining({ contextId: "turn-1" })]);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("cancels active Cartesia contexts on TTS interruption", async () => {
    const receivedRequests: any[] = [];
    const endpointUrl = await createLocalServer((socket) => {
      socket.on("message", (data) => {
        receivedRequests.push(JSON.parse(data.toString()));
      });
    });
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new CartesiaTTSPlugin();

    await plugin.initialize(bus, {
      api_key: "test-cartesia-key",
      endpoint_url: endpointUrl,
      voice_id: "voice-test",
      model_id: "sonic-test",
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
        context_id: "turn-interrupt",
        continue: true,
      }),
      {
        context_id: "turn-interrupt",
        cancel: true,
      },
    ]);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("drops late Cartesia audio and done frames for cancelled contexts", async () => {
    const endpointUrl = await createLocalServer((socket) => {
      socket.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.cancel === true) {
          socket.send(JSON.stringify({
            context_id: msg.context_id,
            data: Buffer.from([9, 8, 7, 6]).toString("base64"),
          }));
          socket.send(JSON.stringify({
            context_id: msg.context_id,
            done: true,
          }));
        }
      });
    });
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new CartesiaTTSPlugin();
    const audio: TextToSpeechAudioPacket[] = [];
    const ends: TextToSpeechEndPacket[] = [];

    bus.on("tts.audio", (pkt) => {
      audio.push(pkt as TextToSpeechAudioPacket);
    });
    bus.on("tts.end", (pkt) => {
      ends.push(pkt as TextToSpeechEndPacket);
    });

    await plugin.initialize(bus, {
      api_key: "test-cartesia-key",
      endpoint_url: endpointUrl,
      voice_id: "voice-test",
      model_id: "sonic-test",
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

  it("emits a typed TTS error and closes the context when Cartesia returns an error frame", async () => {
    const endpointUrl = await createLocalServer((socket) => {
      socket.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        socket.send(JSON.stringify({
          type: "error",
          done: true,
          title: "Invalid model",
          message: "The model is not valid.",
          error_code: "model_not_found",
          status_code: 400,
          context_id: msg.context_id,
        }));
      });
    });
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new CartesiaTTSPlugin();
    const errors: TtsErrorPacket[] = [];
    const ends: TextToSpeechEndPacket[] = [];
    bus.on("tts.error", (pkt) => {
      errors.push(pkt as TtsErrorPacket);
    });
    bus.on("tts.end", (pkt) => {
      ends.push(pkt as TextToSpeechEndPacket);
    });

    await plugin.initialize(bus, {
      api_key: "test-cartesia-key",
      endpoint_url: endpointUrl,
      voice_id: "voice-test",
      model_id: "bad-model",
    });
    bus.push(Route.Main, {
      kind: "tts.text",
      contextId: "turn-error",
      timestampMs: Date.now(),
      text: "This will fail.",
    });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(errors).toEqual([
      expect.objectContaining({
        kind: "tts.error",
        contextId: "turn-error",
        component: "tts",
      }),
    ]);
    expect(errors[0]!.cause.message).toContain("Invalid model");
    expect(ends).toEqual([expect.objectContaining({ contextId: "turn-error" })]);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("turns malformed provider messages into TTS errors instead of throwing from the websocket listener", async () => {
    const endpointUrl = await createLocalServer((socket) => {
      socket.on("message", () => {
        socket.send("{not-json");
      });
    });
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new CartesiaTTSPlugin();
    const errors: TtsErrorPacket[] = [];
    bus.on("tts.error", (pkt) => {
      errors.push(pkt as TtsErrorPacket);
    });

    await plugin.initialize(bus, {
      api_key: "test-cartesia-key",
      endpoint_url: endpointUrl,
      voice_id: "voice-test",
      model_id: "sonic-test",
    });
    bus.push(Route.Main, {
      kind: "tts.text",
      contextId: "turn-malformed",
      timestampMs: Date.now(),
      text: "Trigger malformed provider frame.",
    });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(errors).toEqual([
      expect.objectContaining({
        kind: "tts.error",
        contextId: "turn-malformed",
        component: "tts",
      }),
    ]);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("fails active contexts when the Cartesia websocket closes before provider done", async () => {
    const endpointUrl = await createLocalServer((socket) => {
      socket.on("message", () => {
        socket.close(1011, "provider restart");
      });
    });
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new CartesiaTTSPlugin();
    const errors: TtsErrorPacket[] = [];
    bus.on("tts.error", (pkt) => {
      errors.push(pkt as TtsErrorPacket);
    });

    await plugin.initialize(bus, {
      api_key: "test-cartesia-key",
      endpoint_url: endpointUrl,
      voice_id: "voice-test",
      model_id: "sonic-test",
    });
    bus.push(Route.Main, {
      kind: "tts.text",
      contextId: "turn-close",
      timestampMs: Date.now(),
      text: "This context should fail if the provider closes.",
    });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "tts.error",
        contextId: "turn-close",
        component: "tts",
        cause: expect.objectContaining({
          message: expect.stringContaining("Cartesia TTS WebSocket closed unexpectedly"),
        }),
      }),
    ]));

    await plugin.close();
    bus.stop();
    await started;
  });

  it("does not keep a Cartesia context active when the initial provider send fails", async () => {
    const endpointUrl = await createLocalServer(() => {});
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new CartesiaTTSPlugin();
    const errors: TtsErrorPacket[] = [];
    const ends: TextToSpeechEndPacket[] = [];
    bus.on("tts.error", (pkt) => {
      errors.push(pkt as TtsErrorPacket);
    });
    bus.on("tts.end", (pkt) => {
      ends.push(pkt as TextToSpeechEndPacket);
    });

    await plugin.initialize(bus, {
      api_key: "test-cartesia-key",
      endpoint_url: endpointUrl,
      voice_id: "voice-test",
      model_id: "sonic-test",
    });
    const send = vi.fn();
    Object.assign(plugin as unknown as { ready: boolean; ws: { readyState: number; OPEN: number; send: typeof send; close: () => void } }, {
      ready: true,
      ws: { readyState: 3, OPEN: 1, send, close: vi.fn() },
    });
    bus.push(Route.Main, {
      kind: "tts.text",
      contextId: "turn-unsent",
      timestampMs: Date.now(),
      text: "This request never reaches Cartesia.",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    bus.push(Route.Main, {
      kind: "tts.done",
      contextId: "turn-unsent",
      timestampMs: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(send).not.toHaveBeenCalled();
    expect(errors).toEqual([
      expect.objectContaining({
        kind: "tts.error",
        contextId: "turn-unsent",
        component: "tts",
        cause: expect.objectContaining({
          message: "Cartesia TTS WebSocket is not open",
        }),
      }),
    ]);
    expect(ends).toEqual([expect.objectContaining({ contextId: "turn-unsent" })]);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("does not keep a Cartesia context active when the terminal provider send fails", async () => {
    const endpointUrl = await createLocalServer(() => {});
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new CartesiaTTSPlugin();
    const errors: TtsErrorPacket[] = [];
    bus.on("tts.error", (pkt) => {
      errors.push(pkt as TtsErrorPacket);
    });

    await plugin.initialize(bus, {
      api_key: "test-cartesia-key",
      endpoint_url: endpointUrl,
      voice_id: "voice-test",
      model_id: "sonic-test",
    });
    const send = vi.fn();
    const fakeWs = { readyState: 1, OPEN: 1, send, close: vi.fn() };
    Object.assign(plugin as unknown as { ready: boolean; ws: typeof fakeWs }, {
      ready: true,
      ws: fakeWs,
    });
    bus.push(Route.Main, {
      kind: "tts.text",
      contextId: "turn-terminal-unsent",
      timestampMs: Date.now(),
      text: "This request reaches Cartesia.",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(send).toHaveBeenCalledTimes(1);

    fakeWs.readyState = 3;
    bus.push(Route.Main, {
      kind: "tts.done",
      contextId: "turn-terminal-unsent",
      timestampMs: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(errors).toEqual([
      expect.objectContaining({
        kind: "tts.error",
        contextId: "turn-terminal-unsent",
        component: "tts",
        cause: expect.objectContaining({
          message: "Cartesia TTS WebSocket is not open",
        }),
      }),
    ]);
    expect(send).toHaveBeenCalledTimes(1);

    fakeWs.readyState = 1;
    bus.push(Route.Critical, {
      kind: "interrupt.tts",
      contextId: "turn-terminal-unsent",
      timestampMs: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(send).toHaveBeenCalledTimes(1);

    await plugin.close();
    bus.stop();
    await started;
  });
});
