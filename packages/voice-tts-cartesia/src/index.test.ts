// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import {
  PipelineBusImpl,
  Route,
  type TextToSpeechAudioPacket,
  type TextToSpeechEndPacket,
  type TextToSpeechWordTimestampsPacket,
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

  it("surfaces Cartesia error field text in tts.error cause.message", async () => {
    const endpointUrl = await createLocalServer((socket) => {
      socket.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        socket.send(JSON.stringify({
          type: "error",
          context_id: msg.context_id,
          status_code: 400,
          done: true,
          error: "Model sunsetted: The requested model has been sunsetted and is no longer available.",
        }));
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
      model_id: "bad-model",
    });
    bus.push(Route.Main, {
      kind: "tts.text",
      contextId: "turn-x",
      timestampMs: Date.now(),
      text: "This will fail.",
    });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(errors).toEqual([
      expect.objectContaining({
        kind: "tts.error",
        contextId: "turn-x",
        component: "tts",
      }),
    ]);
    expect(errors[0]!.cause.message).toContain("Model sunsetted");

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

  it("rejects malformed Cartesia audio payloads before playback", async () => {
    const endpointUrl = await createLocalServer((socket) => {
      socket.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        socket.send(JSON.stringify({
          type: "chunk",
          context_id: msg.context_id,
          data: "not-base64",
          done: false,
          status_code: 206,
        }));
      });
    });
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new CartesiaTTSPlugin();
    const audio: TextToSpeechAudioPacket[] = [];
    const errors: TtsErrorPacket[] = [];
    const ends: TextToSpeechEndPacket[] = [];
    bus.on("tts.audio", (pkt) => {
      audio.push(pkt as TextToSpeechAudioPacket);
    });
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
    bus.push(Route.Main, {
      kind: "tts.text",
      contextId: "turn-malformed-audio",
      timestampMs: Date.now(),
      text: "Trigger malformed provider audio.",
    });
    await waitForCondition(() => errors.length > 0);
    bus.push(Route.Main, {
      kind: "tts.done",
      contextId: "turn-malformed-audio",
      timestampMs: Date.now(),
    });
    await waitForCondition(() => ends.length > 0);

    expect(audio).toEqual([]);
    expect(errors).toEqual([
      expect.objectContaining({
        kind: "tts.error",
        contextId: "turn-malformed-audio",
        component: "tts",
        cause: expect.objectContaining({
          message: "Cartesia TTS provider audio data must be valid base64",
        }),
      }),
    ]);
    expect(ends).toEqual([expect.objectContaining({ contextId: "turn-malformed-audio" })]);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("ignores the empty-data flush_done acknowledgement instead of treating it as malformed audio", async () => {
    const endpointUrl = await createLocalServer((socket) => {
      socket.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.transcript === "Hello there.") {
          socket.send(JSON.stringify({
            type: "chunk",
            context_id: msg.context_id,
            data: Buffer.from(new Uint8Array([1, 2, 3, 4])).toString("base64"),
            done: false,
            status_code: 206,
          }));
        }
        if (msg.context_id === "turn-flush" && msg.continue === false) {
          // Real Cartesia answers a flush request with a flush_done control frame
          // that carries an empty `data` string before the terminal done frame.
          socket.send(JSON.stringify({
            type: "flush_done",
            context_id: "turn-flush",
            data: "",
            done: false,
            status_code: 206,
            flush_done: true,
          }));
          socket.send(JSON.stringify({
            type: "done",
            context_id: "turn-flush",
            done: true,
            status_code: 200,
          }));
        }
      });
    });
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new CartesiaTTSPlugin();
    const audio: TextToSpeechAudioPacket[] = [];
    const errors: TtsErrorPacket[] = [];
    const ends: TextToSpeechEndPacket[] = [];
    bus.on("tts.audio", (pkt) => {
      audio.push(pkt as TextToSpeechAudioPacket);
    });
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
      sample_rate: 16000,
    });
    bus.push(Route.Main, {
      kind: "tts.text",
      contextId: "turn-flush",
      timestampMs: Date.now(),
      text: "Hello there.",
    });
    bus.push(Route.Main, {
      kind: "tts.done",
      contextId: "turn-flush",
      timestampMs: Date.now(),
    });
    await waitForCondition(() => ends.length >= 1);

    expect(errors).toEqual([]);
    expect(audio).toEqual([
      expect.objectContaining({
        contextId: "turn-flush",
        audio: new Uint8Array([1, 2, 3, 4]),
      }),
    ]);
    expect(ends).toEqual([expect.objectContaining({ contextId: "turn-flush" })]);

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
          message: expect.stringContaining("WebSocket closed unexpectedly"),
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
    // Simulate a closed socket: the managed connection's send throws.
    const send = vi.fn(() => {
      throw new Error("WebSocket is not open");
    });
    Object.assign(plugin as unknown as { conn: { ensureReady: () => Promise<void>; send: typeof send; close: () => Promise<void> } }, {
      conn: { ensureReady: async () => undefined, send, close: async () => undefined },
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

    // The send was attempted but failed; the context must not stay active —
    // an error fires and the turn ends instead of hanging.
    expect(send).toHaveBeenCalled();
    expect(errors).toEqual([
      expect.objectContaining({
        kind: "tts.error",
        contextId: "turn-unsent",
        component: "tts",
        cause: expect.objectContaining({
          message: "WebSocket is not open",
        }),
      }),
    ]);
    expect(ends).toEqual([expect.objectContaining({ contextId: "turn-unsent" })]);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("emits tts.word_timestamps with cumulative offsets when provider returns word_timestamps", async () => {
    const audioChunk1 = new Uint8Array(3200); // 3200 bytes = 100ms at 16kHz PCM16
    const audioChunk2 = new Uint8Array(1600); // 1600 bytes = 50ms at 16kHz PCM16
    const endpointUrl = await createLocalServer((socket) => {
      socket.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.transcript === "Hello world.") {
          // First chunk: word "Hello" at 0–0.4s, "world." at 0.5–0.9s
          socket.send(JSON.stringify({
            type: "chunk",
            context_id: msg.context_id,
            data: Buffer.from(audioChunk1).toString("base64"),
            word_timestamps: {
              words: [
                { word: "Hello", start: 0.0, end: 0.4 },
                { word: "world.", start: 0.5, end: 0.9 },
              ],
            },
            done: false,
            status_code: 206,
          }));
          // Second chunk: word "Goodbye." at 0.0–0.4s relative (= 150ms offset from context start)
          socket.send(JSON.stringify({
            type: "chunk",
            context_id: msg.context_id,
            data: Buffer.from(audioChunk2).toString("base64"),
            word_timestamps: {
              words: [
                { word: "Goodbye.", start: 0.0, end: 0.4 },
              ],
            },
            done: false,
            status_code: 206,
          }));
        }
        if (msg.continue === false) {
          socket.send(JSON.stringify({ type: "done", context_id: msg.context_id, done: true, status_code: 200 }));
        }
      });
    });

    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new CartesiaTTSPlugin();
    const wordTsPackets: TextToSpeechWordTimestampsPacket[] = [];
    bus.on("tts.word_timestamps", (pkt) => {
      wordTsPackets.push(pkt as TextToSpeechWordTimestampsPacket);
    });

    await plugin.initialize(bus, {
      api_key: "test-cartesia-key",
      endpoint_url: endpointUrl,
      voice_id: "voice-test",
      model_id: "sonic-test",
      sample_rate: 16000,
    });
    bus.push(Route.Main, { kind: "tts.text", contextId: "turn-ts", timestampMs: Date.now(), text: "Hello world." });
    bus.push(Route.Main, { kind: "tts.done", contextId: "turn-ts", timestampMs: Date.now(), text: "Hello world." });
    await waitForCondition(() => wordTsPackets.length >= 2);

    // Chunk 1: timestamps start at 0 (no prior offset).
    expect(wordTsPackets[0]!.words).toEqual([
      { word: "Hello",  startMs: 0,   endMs: 400 },
      { word: "world.", startMs: 500, endMs: 900 },
    ]);
    // Chunk 2: timestamps offset by chunk1 audio duration (3200 bytes / 2 / 16000 * 1000 = 100ms).
    expect(wordTsPackets[1]!.words).toEqual([
      { word: "Goodbye.", startMs: 100, endMs: 500 },
    ]);

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
    // The first send (the transcript) succeeds; the terminal flush send fails.
    let failNext = false;
    const send = vi.fn(() => {
      if (failNext) throw new Error("WebSocket is not open");
    });
    Object.assign(plugin as unknown as { conn: { ensureReady: () => Promise<void>; send: typeof send; close: () => Promise<void> } }, {
      conn: { ensureReady: async () => undefined, send, close: async () => undefined },
    });
    bus.push(Route.Main, {
      kind: "tts.text",
      contextId: "turn-terminal-unsent",
      timestampMs: Date.now(),
      text: "This request reaches Cartesia.",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(send).toHaveBeenCalledTimes(1);

    failNext = true;
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
          message: "WebSocket is not open",
        }),
      }),
    ]);
    expect(send).toHaveBeenCalledTimes(2);

    failNext = false;
    bus.push(Route.Critical, {
      kind: "interrupt.tts",
      contextId: "turn-terminal-unsent",
      timestampMs: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The context was already removed, so the interrupt sends no Cancel.
    expect(send).toHaveBeenCalledTimes(2);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("clears cumulative audio offset state when Cartesia returns an error frame", async () => {
    let sendCount = 0;
    const endpointUrl = await createLocalServer((socket) => {
      socket.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        sendCount += 1;
        if (sendCount === 1) {
          socket.send(JSON.stringify({
            type: "chunk",
            context_id: msg.context_id,
            data: Buffer.from(new Uint8Array(3200)).toString("base64"),
            word_timestamps: {
              words: [{ word: "Hi", start: 0.0, end: 0.1 }],
            },
            done: false,
            status_code: 206,
          }));
          socket.send(JSON.stringify({
            type: "error",
            done: true,
            title: "Provider failed",
            status_code: 500,
            context_id: msg.context_id,
          }));
          return;
        }
        socket.send(JSON.stringify({
          type: "chunk",
          context_id: msg.context_id,
          data: Buffer.from(new Uint8Array(1600)).toString("base64"),
          word_timestamps: {
            words: [{ word: "Again", start: 0.0, end: 0.1 }],
          },
          done: false,
          status_code: 206,
        }));
        if (msg.continue === false) {
          socket.send(JSON.stringify({
            type: "done",
            context_id: msg.context_id,
            done: true,
            status_code: 200,
          }));
        }
      });
    });
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new CartesiaTTSPlugin();
    const wordTsPackets: TextToSpeechWordTimestampsPacket[] = [];
    bus.on("tts.word_timestamps", (pkt) => {
      wordTsPackets.push(pkt as TextToSpeechWordTimestampsPacket);
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
      contextId: "turn-offset-reset",
      timestampMs: Date.now(),
      text: "first try",
    });
    await waitForCondition(() => wordTsPackets.length >= 1);
    bus.push(Route.Main, {
      kind: "tts.text",
      contextId: "turn-offset-reset",
      timestampMs: Date.now(),
      text: "second try",
    });
    bus.push(Route.Main, {
      kind: "tts.done",
      contextId: "turn-offset-reset",
      timestampMs: Date.now(),
    });
    await waitForCondition(() => wordTsPackets.length >= 2);

    expect(wordTsPackets[0]!.words[0]?.startMs).toBe(0);
    expect(wordTsPackets[1]!.words[0]?.startMs).toBe(0);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("derives word-timestamp offsets from cumulative sample count without per-chunk rounding drift", async () => {
    const chunkBytes = 333;
    const chunkCount = 120;
    const endpointUrl = await createLocalServer((socket) => {
      socket.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.transcript === "Long turn.") {
          for (let i = 0; i < chunkCount; i += 1) {
            socket.send(JSON.stringify({
              type: "chunk",
              context_id: msg.context_id,
              data: Buffer.from(new Uint8Array(chunkBytes)).toString("base64"),
              word_timestamps: i === chunkCount - 1
                ? { words: [{ word: "end", start: 0.0, end: 0.01 }] }
                : undefined,
              done: false,
              status_code: 206,
            }));
          }
        }
        if (msg.continue === false) {
          socket.send(JSON.stringify({
            type: "done",
            context_id: msg.context_id,
            done: true,
            status_code: 200,
          }));
        }
      });
    });
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new CartesiaTTSPlugin();
    const wordTsPackets: TextToSpeechWordTimestampsPacket[] = [];
    bus.on("tts.word_timestamps", (pkt) => {
      wordTsPackets.push(pkt as TextToSpeechWordTimestampsPacket);
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
      contextId: "turn-drift",
      timestampMs: Date.now(),
      text: "Long turn.",
    });
    bus.push(Route.Main, {
      kind: "tts.done",
      contextId: "turn-drift",
      timestampMs: Date.now(),
    });
    await waitForCondition(() => wordTsPackets.length >= 1);

    const totalSamples = (chunkBytes / 2) * chunkCount;
    const expectedOffsetMs = Math.floor((totalSamples * 1000) / 16000) - Math.floor((chunkBytes / 2 * 1000) / 16000);
    const roundedOffsetMs = (() => {
      let offsetMs = 0;
      for (let i = 0; i < chunkCount - 1; i += 1) {
        offsetMs += Math.round(((chunkBytes / 2) / 16000) * 1000);
      }
      return offsetMs;
    })();
    expect(expectedOffsetMs).not.toBe(roundedOffsetMs);
    expect(wordTsPackets.at(-1)!.words[0]?.startMs).toBe(expectedOffsetMs);

    await plugin.close();
    bus.stop();
    await started;
  });
});
