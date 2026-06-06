// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from "vitest";
import * as voice from "@kuralle-syrinx/core";
import { WebSocketServer, type WebSocket } from "ws";
import {
  PipelineBusImpl,
  Route,
  type TextToSpeechAudioPacket,
  type TextToSpeechEndPacket,
  type TtsErrorPacket,
} from "@kuralle-syrinx/core";

import { DeepgramTTSPlugin } from "./tts.js";

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
    onConnection(socket, request.url ?? "", Array.isArray(header) ? header[0] ?? "" : header ?? "");
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address");
  return `ws://127.0.0.1:${address.port}/v1/speak`;
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for Deepgram test condition");
}

describe("DeepgramTTSPlugin", () => {
  it("streams sentences as Speak messages and ends the turn on Flushed", async () => {
    const received: Array<Record<string, unknown>> = [];
    const endpointUrl = await createLocalServer((socket, requestUrl, authHeader) => {
      expect(requestUrl).toContain("model=aura-2-thalia-en");
      expect(requestUrl).toContain("encoding=linear16");
      expect(requestUrl).toContain("container=none");
      expect(authHeader).toBe("Token test-deepgram-key");
      socket.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        received.push(msg);
        if (msg["type"] === "Speak") {
          socket.send(Buffer.from([1, 2, 3, 4]), { binary: true });
        }
        if (msg["type"] === "Flush") {
          socket.send(JSON.stringify({ type: "Flushed", sequence_id: 0 }));
        }
      });
    });

    const bus = new PipelineBusImpl();
    const started = bus.start();
    const plugin = new DeepgramTTSPlugin();
    const audio: TextToSpeechAudioPacket[] = [];
    const ends: TextToSpeechEndPacket[] = [];
    bus.on("tts.audio", (pkt) => { audio.push(pkt as TextToSpeechAudioPacket); });
    bus.on("tts.end", (pkt) => { ends.push(pkt as TextToSpeechEndPacket); });

    await plugin.initialize(bus, {
      api_key: "test-deepgram-key",
      endpoint_url: endpointUrl,
      sample_rate: 24000,
    });
    bus.push(Route.Main, { kind: "tts.text", contextId: "turn-1", timestampMs: Date.now(), text: "Hello there." });
    bus.push(Route.Main, { kind: "tts.text", contextId: "turn-1", timestampMs: Date.now(), text: "Second sentence." });
    bus.push(Route.Main, { kind: "tts.done", contextId: "turn-1", timestampMs: Date.now() });
    await waitForCondition(() => ends.length >= 1 && audio.length >= 2);

    expect(received).toEqual([
      expect.objectContaining({ type: "Speak", text: "Hello there." }),
      expect.objectContaining({ type: "Speak", text: "Second sentence." }),
      expect.objectContaining({ type: "Flush" }),
    ]);
    expect(audio.every((a) => a.contextId === "turn-1" && a.sampleRateHz === 24000)).toBe(true);
    expect(audio[0]!.audio).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(ends).toEqual([expect.objectContaining({ contextId: "turn-1" })]);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("emits tts.end when Deepgram streams audio but never acknowledges Flush", async () => {
    const received: Array<Record<string, unknown>> = [];
    const endpointUrl = await createLocalServer((socket) => {
      socket.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        received.push(msg);
        if (msg["type"] === "Speak") socket.send(Buffer.from([5, 6, 7, 8]), { binary: true });
      });
    });

    const bus = new PipelineBusImpl();
    const started = bus.start();
    const plugin = new DeepgramTTSPlugin();
    const audio: TextToSpeechAudioPacket[] = [];
    const ends: TextToSpeechEndPacket[] = [];
    const metrics: Array<{ name?: string; value?: string; contextId?: string }> = [];
    bus.on("tts.audio", (pkt) => { audio.push(pkt as TextToSpeechAudioPacket); });
    bus.on("tts.end", (pkt) => { ends.push(pkt as TextToSpeechEndPacket); });
    bus.on("metric.conversation", (pkt) => {
      const metric = pkt as { name?: string; value?: string; contextId?: string };
      metrics.push(metric);
    });

    await plugin.initialize(bus, {
      api_key: "test-deepgram-key",
      endpoint_url: endpointUrl,
      finish_timeout_ms: 20,
    });
    bus.push(Route.Main, { kind: "tts.text", contextId: "turn-timeout", timestampMs: Date.now(), text: "Finish me." });
    bus.push(Route.Main, { kind: "tts.done", contextId: "turn-timeout", timestampMs: Date.now() });
    await waitForCondition(() => ends.length >= 1);

    expect(received).toEqual([
      expect.objectContaining({ type: "Speak", text: "Finish me." }),
      expect.objectContaining({ type: "Flush" }),
    ]);
    expect(audio).toEqual([
      expect.objectContaining({
        contextId: "turn-timeout",
        audio: new Uint8Array([5, 6, 7, 8]),
      }),
    ]);
    expect(ends).toEqual([expect.objectContaining({ contextId: "turn-timeout" })]);
    expect(metrics).toContainEqual(expect.objectContaining({
      contextId: "turn-timeout",
      name: "tts.deepgram.finish_timeout",
      value: "20",
    }));

    await plugin.close();
    bus.stop();
    await started;
  });

  it("sends Clear and drops further audio on interruption", async () => {
    const received: Array<Record<string, unknown>> = [];
    let socketRef: WebSocket | null = null;
    const endpointUrl = await createLocalServer((socket) => {
      socketRef = socket;
      socket.on("message", (data) => {
        received.push(JSON.parse(data.toString()) as Record<string, unknown>);
      });
    });

    const bus = new PipelineBusImpl();
    const started = bus.start();
    const plugin = new DeepgramTTSPlugin();
    const audio: TextToSpeechAudioPacket[] = [];
    bus.on("tts.audio", (pkt) => { audio.push(pkt as TextToSpeechAudioPacket); });

    await plugin.initialize(bus, { api_key: "test-deepgram-key", endpoint_url: endpointUrl });
    bus.push(Route.Main, { kind: "tts.text", contextId: "turn-x", timestampMs: Date.now(), text: "Interrupt me." });
    await waitForCondition(() => received.some((m) => m["type"] === "Speak"));
    bus.push(Route.Critical, { kind: "interrupt.tts", contextId: "turn-x", timestampMs: Date.now() });
    await waitForCondition(() => received.some((m) => m["type"] === "Clear"));

    // Audio arriving after the interrupt for the cancelled turn must be dropped.
    socketRef!.send(Buffer.from([9, 9]), { binary: true });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(received).toEqual([
      expect.objectContaining({ type: "Speak", text: "Interrupt me." }),
      expect.objectContaining({ type: "Clear" }),
    ]);
    expect(audio).toEqual([]);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("drops the interrupted turn's trailing PCM instead of misattributing it to the next turn", async () => {
    const received: Array<Record<string, unknown>> = [];
    let socketRef: WebSocket | null = null;
    const endpointUrl = await createLocalServer((socket) => {
      socketRef = socket;
      socket.on("message", (data) => {
        received.push(JSON.parse(data.toString()) as Record<string, unknown>);
      });
    });

    const bus = new PipelineBusImpl();
    const started = bus.start();
    const plugin = new DeepgramTTSPlugin();
    const audio: TextToSpeechAudioPacket[] = [];
    bus.on("tts.audio", (pkt) => { audio.push(pkt as TextToSpeechAudioPacket); });

    await plugin.initialize(bus, { api_key: "test-deepgram-key", endpoint_url: endpointUrl });

    // Turn 1 speaks, user barges in -> Clear is sent and clearedPending arms.
    bus.push(Route.Main, { kind: "tts.text", contextId: "turn-1", timestampMs: Date.now(), text: "First turn." });
    await waitForCondition(() => received.some((m) => m["type"] === "Speak"));
    bus.push(Route.Critical, { kind: "interrupt.tts", contextId: "turn-1", timestampMs: Date.now() });
    await waitForCondition(() => received.some((m) => m["type"] === "Clear"));

    // Turn 2 starts before Deepgram acks the Clear: currentContextId is now turn-2.
    bus.push(Route.Main, { kind: "tts.text", contextId: "turn-2", timestampMs: Date.now(), text: "Second turn." });
    await waitForCondition(() => received.filter((m) => m["type"] === "Speak").length >= 2);

    // Trailing PCM from the interrupted turn arrives before "Cleared" — must be
    // dropped, never attributed to turn-2.
    socketRef!.send(Buffer.from([9, 9]), { binary: true });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Deepgram acks the Clear; turn-2's real audio follows and must be emitted.
    socketRef!.send(JSON.stringify({ type: "Cleared" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    socketRef!.send(Buffer.from([2, 2]), { binary: true });
    await waitForCondition(() => audio.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(audio).toEqual([
      expect.objectContaining({ contextId: "turn-2", audio: new Uint8Array([2, 2]) }),
    ]);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("emits a typed TTS error when Deepgram returns an Error frame", async () => {
    const endpointUrl = await createLocalServer((socket) => {
      socket.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg["type"] === "Speak") {
          socket.send(JSON.stringify({ type: "Error", description: "model not found" }));
        }
      });
    });

    const bus = new PipelineBusImpl();
    const started = bus.start();
    const plugin = new DeepgramTTSPlugin();
    const errors: TtsErrorPacket[] = [];
    bus.on("tts.error", (pkt) => { errors.push(pkt as TtsErrorPacket); });

    await plugin.initialize(bus, { api_key: "test-deepgram-key", endpoint_url: endpointUrl });
    bus.push(Route.Main, { kind: "tts.text", contextId: "turn-err", timestampMs: Date.now(), text: "Fail please." });
    await waitForCondition(() => errors.length > 0);

    expect(errors[0]).toEqual(
      expect.objectContaining({ kind: "tts.error", contextId: "turn-err", component: "tts" }),
    );
    expect(errors[0]!.cause.message).toContain("model not found");

    await plugin.close();
    bus.stop();
    await started;
  });

  it("realigns PCM split across binary frame boundaries", async () => {
    const endpointUrl = await createLocalServer((socket) => {
      socket.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg["type"] === "Speak") {
          // Three bytes then one byte: the plugin must carry the odd byte over so
          // every emitted chunk stays 16-bit aligned (no half-sample corruption).
          socket.send(Buffer.from([0x11, 0x22, 0x33]), { binary: true });
          socket.send(Buffer.from([0x44]), { binary: true });
        }
        if (msg["type"] === "Flush") socket.send(JSON.stringify({ type: "Flushed", sequence_id: 0 }));
      });
    });

    const bus = new PipelineBusImpl();
    const started = bus.start();
    const plugin = new DeepgramTTSPlugin();
    const audio: TextToSpeechAudioPacket[] = [];
    const ends: TextToSpeechEndPacket[] = [];
    bus.on("tts.audio", (pkt) => { audio.push(pkt as TextToSpeechAudioPacket); });
    bus.on("tts.end", (pkt) => { ends.push(pkt as TextToSpeechEndPacket); });

    await plugin.initialize(bus, { api_key: "test-deepgram-key", endpoint_url: endpointUrl });
    bus.push(Route.Main, { kind: "tts.text", contextId: "turn-a", timestampMs: Date.now(), text: "Align me." });
    bus.push(Route.Main, { kind: "tts.done", contextId: "turn-a", timestampMs: Date.now() });
    await waitForCondition(() => ends.length >= 1);

    const allBytes = Buffer.concat(audio.map((a) => Buffer.from(a.audio)));
    expect(allBytes).toEqual(Buffer.from([0x11, 0x22, 0x33, 0x44]));
    expect(audio.every((a) => a.audio.byteLength % 2 === 0)).toBe(true);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("emits tts.error when received PCM fails structural validation", async () => {
    const payloadSpy = vi.spyOn(voice, "assertAudioPayload").mockImplementationOnce(() => {
      throw new Error("PCM16 payload must contain an even number of bytes");
    });
    const endpointUrl = await createLocalServer((socket) => {
      socket.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg["type"] === "Speak") {
          socket.send(Buffer.from([1, 2, 3, 4]), { binary: true });
        }
        if (msg["type"] === "Flush") {
          socket.send(JSON.stringify({ type: "Flushed", sequence_id: 0 }));
        }
      });
    });

    const bus = new PipelineBusImpl();
    const started = bus.start();
    const plugin = new DeepgramTTSPlugin();
    const audio: TextToSpeechAudioPacket[] = [];
    const errors: TtsErrorPacket[] = [];
    bus.on("tts.audio", (pkt) => { audio.push(pkt as TextToSpeechAudioPacket); });
    bus.on("tts.error", (pkt) => { errors.push(pkt as TtsErrorPacket); });

    await plugin.initialize(bus, { api_key: "test-deepgram-key", endpoint_url: endpointUrl });
    bus.push(Route.Main, { kind: "tts.text", contextId: "turn-bad", timestampMs: Date.now(), text: "Bad framing." });
    await waitForCondition(() => errors.length > 0);

    expect(audio).toEqual([]);
    expect(errors[0]).toEqual(
      expect.objectContaining({
        kind: "tts.error",
        contextId: "turn-bad",
        component: "tts",
        cause: expect.objectContaining({
          message: "PCM16 payload must contain an even number of bytes",
        }),
      }),
    );
    payloadSpy.mockRestore();

    await plugin.close();
    bus.stop();
    await started;
  });
});
