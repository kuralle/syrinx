// SPDX-License-Identifier: MIT

import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  Route,
  VoiceAgentSession,
  type ConversationMetricPacket,
  type UserAudioReceivedPacket,
  type UserTextReceivedPacket,
} from "@asyncdot/voice";
import {
  createSmartPbxMediaStreamServer,
  createTelnyxMediaStreamServer,
  createTwilioMediaStreamServer,
  createVoiceWebSocketServer,
} from "./index.js";

function websocketUrl(port: number): string {
  return `ws://127.0.0.1:${port}/ws`;
}

function websocketUrlWithSession(port: number, sessionId: string): string {
  return `ws://127.0.0.1:${port}/ws?sessionId=${encodeURIComponent(sessionId)}`;
}

const BINARY_AUDIO_ENVELOPE_MAGIC = Buffer.from("SYRXA1\n", "ascii");

async function openClientAndReadReady(url: string): Promise<[WebSocket, any]> {
  const socket = new WebSocket(url);
  const ready = readJson(socket);
  await new Promise<void>((resolveOpen, reject) => {
    socket.once("open", resolveOpen);
    socket.once("error", reject);
  });
  return [socket, await ready];
}

async function openClient(url: string, options?: WebSocket.ClientOptions): Promise<WebSocket> {
  const socket = new WebSocket(url, options);
  await new Promise<void>((resolveOpen, reject) => {
    socket.once("open", resolveOpen);
    socket.once("error", reject);
  });
  return socket;
}

async function readJson(socket: WebSocket): Promise<any> {
  return await new Promise((resolve) => {
    socket.once("message", (data) => {
      resolve(JSON.parse(data.toString()));
    });
  });
}

function encodeTestBinaryAudioEnvelope(header: Record<string, unknown>, audio: Uint8Array): Buffer {
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const output = Buffer.alloc(BINARY_AUDIO_ENVELOPE_MAGIC.byteLength + 4 + headerBytes.byteLength + audio.byteLength);
  BINARY_AUDIO_ENVELOPE_MAGIC.copy(output, 0);
  output.writeUInt32LE(headerBytes.byteLength, BINARY_AUDIO_ENVELOPE_MAGIC.byteLength);
  headerBytes.copy(output, BINARY_AUDIO_ENVELOPE_MAGIC.byteLength + 4);
  Buffer.from(audio).copy(output, BINARY_AUDIO_ENVELOPE_MAGIC.byteLength + 4 + headerBytes.byteLength);
  return output;
}

function decodeTestBinaryAudioEnvelope(data: Buffer): { readonly header: any; readonly audio: Buffer } {
  expect(data.subarray(0, BINARY_AUDIO_ENVELOPE_MAGIC.byteLength)).toEqual(BINARY_AUDIO_ENVELOPE_MAGIC);
  const headerLength = data.readUInt32LE(BINARY_AUDIO_ENVELOPE_MAGIC.byteLength);
  const headerStart = BINARY_AUDIO_ENVELOPE_MAGIC.byteLength + 4;
  const headerEnd = headerStart + headerLength;
  return {
    header: JSON.parse(data.subarray(headerStart, headerEnd).toString("utf8")),
    audio: data.subarray(headerEnd),
  };
}

describe("createVoiceWebSocketServer", () => {
  it("routes multiple provider websocket paths on a shared HTTP server without handshake cross-talk", async () => {
    const httpServer = createServer();
    const [twilio, telnyx, smartpbx] = await Promise.all([
      createTwilioMediaStreamServer({
        server: httpServer,
        createSession: () => new VoiceAgentSession({ plugins: {} }),
      }),
      createTelnyxMediaStreamServer({
        server: httpServer,
        createSession: () => new VoiceAgentSession({ plugins: {} }),
      }),
      createSmartPbxMediaStreamServer({
        server: httpServer,
        createSession: () => new VoiceAgentSession({ plugins: {} }),
      }),
    ]);
    await new Promise<void>((resolveListen, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", () => {
        httpServer.off("error", reject);
        resolveListen();
      });
    });
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const clients = await Promise.all([
      openClient(`ws://127.0.0.1:${String(address.port)}/twilio`, { perMessageDeflate: false }),
      openClient(`ws://127.0.0.1:${String(address.port)}/telnyx`, { perMessageDeflate: false }),
      openClient(`ws://127.0.0.1:${String(address.port)}/media-stream`, { perMessageDeflate: false }),
    ]);
    expect(clients.map((client) => client.readyState)).toEqual([
      WebSocket.OPEN,
      WebSocket.OPEN,
      WebSocket.OPEN,
    ]);

    for (const client of clients) client.close();
    await Promise.all([twilio.close(), telnyx.close(), smartpbx.close()]);
    await new Promise<void>((resolveClose) => httpServer.close(() => resolveClose()));
  });

  it("does not negotiate websocket compression for browser media sessions", async () => {
    const server = await createVoiceWebSocketServer({
      port: 0,
      createSession: () => new VoiceAgentSession({ plugins: {} }),
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openClient(websocketUrl(address.port), { perMessageDeflate: true });
    expect(client.extensions).toBe("");

    client.close();
    await server.close();
  });

  it("bridges binary browser audio into v2 user.audio_received packets", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });

    const server = await createVoiceWebSocketServer({
      port: 0,
      createSession: () => session,
      contextId: () => "turn-test",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client, ready] = await openClientAndReadReady(websocketUrl(address.port));
    expect(ready).toMatchObject({ type: "ready", turnId: "turn-test", resumed: false });
    expect(ready.sessionId).toMatch(/^session-/);
    expect(ready.maxSessionDurationMs).toBe(30 * 60_000);
    expect(ready.audio).toMatchObject({
      inputSampleRateHz: 16000,
      outputSampleRateHz: 16000,
      encoding: "pcm_s16le",
      channels: 1,
      binaryEnvelope: "syrinx.audio.v1",
      maxInboundMessageBytes: 2097152,
    });

    client.send(Buffer.from([1, 2, 3, 4]));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received).toEqual([
      expect.objectContaining({
        kind: "user.audio_received",
        contextId: "turn-test",
        audio: new Uint8Array([1, 2, 3, 4]),
      }),
    ]);

    client.close();
    await server.close();
  });

  it("buffers early websocket input sent before session ready", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });

    const server = await createVoiceWebSocketServer({
      port: 0,
      createSession: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return session;
      },
      contextId: () => "turn-early",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = new WebSocket(websocketUrl(address.port));
    const ready = readJson(client);
    await new Promise<void>((resolveOpen, reject) => {
      client.once("open", resolveOpen);
      client.once("error", reject);
    });
    client.send(Buffer.from([1, 2, 3, 4]));

    await expect(ready).resolves.toMatchObject({ type: "ready", turnId: "turn-early" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received).toEqual([
      expect.objectContaining({
        kind: "user.audio_received",
        contextId: "turn-early",
        audio: new Uint8Array([1, 2, 3, 4]),
      }),
    ]);

    client.close();
    await server.close();
  });

  it("reports malformed early websocket input as a transport error after ready", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });

    const server = await createVoiceWebSocketServer({
      port: 0,
      createSession: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return session;
      },
      contextId: () => "turn-early",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = new WebSocket(websocketUrl(address.port));
    const messages: any[] = [];
    const transportError = new Promise<any>((resolve) => {
      client.on("message", (data, isBinary) => {
        if (isBinary) return;
        const message = JSON.parse(data.toString());
        messages.push(message);
        if (message.type === "error") resolve(message);
      });
    });
    await new Promise<void>((resolveOpen, reject) => {
      client.once("open", resolveOpen);
      client.once("error", reject);
    });
    client.send(Buffer.from([1, 2, 3]));

    await expect(transportError).resolves.toMatchObject({
      type: "error",
      component: "transport",
      category: "invalid_input",
      message: "PCM16 audio payload must contain an even number of bytes",
    });
    expect(messages.some((message) => message.type === "ready")).toBe(true);
    expect(received).toEqual([]);

    client.close();
    await server.close();
  });

  it("closes browser websocket connections when session startup exceeds startupTimeoutMs", async () => {
    const server = await createVoiceWebSocketServer({
      port: 0,
      startupTimeoutMs: 10,
      createSession: () => new Promise<VoiceAgentSession>(() => undefined),
      contextId: () => "turn-startup-timeout",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openClient(websocketUrl(address.port));
    const errorMessage = readJson(client);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      client.once("close", (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
    });

    await expect(errorMessage).resolves.toMatchObject({
      type: "error",
      component: "session",
      category: "startup_timeout",
    });
    await expect(closed).resolves.toEqual({
      code: 1011,
      reason: "session initialization failed",
    });

    await server.close();
  });

  it("resumes a browser websocket session within the retention window", async () => {
    let created = 0;
    const session = new VoiceAgentSession({ plugins: {} });
    const textPackets: UserTextReceivedPacket[] = [];
    session.bus.on("user.text_received", (pkt) => {
      textPackets.push(pkt as UserTextReceivedPacket);
    });

    const server = await createVoiceWebSocketServer({
      port: 0,
      resumeWindowMs: 200,
      createSession: () => {
        created += 1;
        return session;
      },
      contextId: () => "turn-test",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [first, firstReady] = await openClientAndReadReady(websocketUrlWithSession(address.port, "resume-test"));
    expect(firstReady).toMatchObject({
      type: "ready",
      sessionId: "resume-test",
      resumed: false,
    });
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const [second, secondReady] = await openClientAndReadReady(websocketUrlWithSession(address.port, "resume-test"));
    expect(secondReady).toMatchObject({
      type: "ready",
      sessionId: "resume-test",
      resumed: true,
    });
    second.send(JSON.stringify({ type: "text", text: "after reconnect", contextId: "turn-resumed" }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(created).toBe(1);
    expect(textPackets).toEqual([
      expect.objectContaining({
        kind: "user.text_received",
        contextId: "turn-resumed",
        text: "after reconnect",
      }),
    ]);

    second.close();
    await server.close();
  });

  it("closes retained browser websocket sessions after the resume window expires", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const closeSpy = vi.spyOn(session, "close");

    const server = await createVoiceWebSocketServer({
      port: 0,
      resumeWindowMs: 10,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openClientAndReadReady(websocketUrlWithSession(address.port, "expire-test"));
    client.close();
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(session.state).toBe("closed");

    await server.close();
  });

  it("bridges browser text messages and streams TTS audio back to the socket", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const textPackets: UserTextReceivedPacket[] = [];
    session.bus.on("user.text_received", (pkt) => {
      textPackets.push(pkt as UserTextReceivedPacket);
    });

    const server = await createVoiceWebSocketServer({
      port: 0,
      createSession: () => session,
      contextId: () => "turn-test",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openClientAndReadReady(websocketUrl(address.port));

    const audioMessage = new Promise<Buffer>((resolve) => {
      client.on("message", (data, isBinary) => {
        if (isBinary) resolve(data as Buffer);
      });
    });
    const metadataMessage = new Promise<any>((resolve) => {
      client.on("message", (data, isBinary) => {
        if (isBinary) return;
        const message = JSON.parse(data.toString());
        if (message.type === "tts_chunk") resolve(message);
      });
    });

    client.send(JSON.stringify({ type: "text", text: "hello", contextId: "turn-2" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "turn-2",
      timestampMs: Date.now(),
      audio: new Uint8Array([8, 9, 10, 11]),
    });

    expect(textPackets).toEqual([
      expect.objectContaining({
        kind: "user.text_received",
        contextId: "turn-2",
        text: "hello",
      }),
    ]);
    await expect(metadataMessage).resolves.toEqual({
      type: "tts_chunk",
      turnId: "turn-2",
      sequence: 1,
      sampleRateHz: 16000,
      encoding: "pcm_s16le",
      channels: 1,
      byteLength: 4,
      durationMs: 0,
    });
    const envelope = decodeTestBinaryAudioEnvelope(await audioMessage);
    expect(envelope.header).toMatchObject({
      type: "audio",
      contextId: "turn-2",
      sequence: 1,
      sampleRateHz: 16000,
      byteLength: 4,
    });
    expect(envelope.audio).toEqual(Buffer.from([8, 9, 10, 11]));

    client.close();
    await server.close();
  });

  it("forwards VAD-driven assistant interruption as audio clear events", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = await createVoiceWebSocketServer({
      port: 0,
      createSession: () => session,
      contextId: () => "turn-test",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openClientAndReadReady(websocketUrl(address.port));
    const clearMessage = new Promise<any>((resolve) => {
      client.on("message", (data, isBinary) => {
        if (isBinary) return;
        const message = JSON.parse(data.toString());
        if (message.type === "audio_clear") resolve(message);
      });
    });

    session.bus.push(Route.Critical, {
      kind: "interrupt.tts",
      contextId: "assistant-turn",
      timestampMs: Date.now(),
    });

    await expect(clearMessage).resolves.toEqual({
      type: "audio_clear",
      turnId: "assistant-turn",
      reason: "barge_in",
    });

    client.close();
    await server.close();
  });

  it("does not send late browser audio chunks after a TTS interruption", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = await createVoiceWebSocketServer({
      port: 0,
      createSession: () => session,
      contextId: () => "turn-test",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openClientAndReadReady(websocketUrl(address.port));
    const messages: any[] = [];
    const binaries: Buffer[] = [];
    client.on("message", (data, isBinary) => {
      if (isBinary) {
        binaries.push(Buffer.from(data as Buffer));
        return;
      }
      messages.push(JSON.parse(data.toString()));
    });

    session.bus.push(Route.Critical, {
      kind: "interrupt.tts",
      contextId: "assistant-turn",
      timestampMs: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "assistant-turn",
      timestampMs: Date.now(),
      audio: new Uint8Array([1, 2, 3, 4]),
    });
    session.bus.push(Route.Main, {
      kind: "tts.end",
      contextId: "assistant-turn",
      timestampMs: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(messages.some((message) => message.type === "audio_clear")).toBe(true);
    expect(messages.some((message) => message.type === "tts_chunk" || message.type === "tts_end")).toBe(false);
    expect(binaries).toEqual([]);

    client.close();
    await server.close();
  });

  it("forwards VAD speech boundary events to websocket clients", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = await createVoiceWebSocketServer({
      port: 0,
      createSession: () => session,
      contextId: () => "turn-test",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openClientAndReadReady(websocketUrl(address.port));
    const messages: any[] = [];
    const speechMessages = new Promise<any[]>((resolve) => {
      client.on("message", (data, isBinary) => {
        if (isBinary) return;
        const message = JSON.parse(data.toString());
        if (message.type === "speech_started" || message.type === "speech_ended") {
          messages.push(message);
        }
        if (messages.length === 2) resolve(messages);
      });
    });

    session.bus.push(Route.Main, {
      kind: "vad.speech_started",
      contextId: "turn-2",
      timestampMs: Date.now(),
      confidence: 0.91,
    });
    session.bus.push(Route.Main, {
      kind: "vad.speech_ended",
      contextId: "turn-2",
      timestampMs: Date.now(),
    });

    await expect(speechMessages).resolves.toEqual([
      { type: "speech_started", turnId: "turn-2" },
      { type: "speech_ended", turnId: "turn-2" },
    ]);

    client.close();
    await server.close();
  });

  it("normalizes JSON audio frames with explicit sample-rate metadata to the engine rate", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });

    const server = await createVoiceWebSocketServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: () => session,
      contextId: () => "turn-test",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openClientAndReadReady(websocketUrl(address.port));
    const samples48k = new Int16Array([0, 3000, 6000, 9000, 12000, 15000]);

    client.send(JSON.stringify({
      type: "audio",
      contextId: "turn-resample",
      sampleRateHz: 48000,
      audio: Buffer.from(samples48k.buffer).toString("base64"),
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received).toEqual([
      expect.objectContaining({
        kind: "user.audio_received",
        contextId: "turn-resample",
      }),
    ]);
    expect(Buffer.from(received[0]!.audio)).toEqual(Buffer.from(new Int16Array([0, 9000]).buffer));

    client.close();
    await server.close();
  });

  it("rejects JSON audio that changes sample rate inside the same websocket context", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });

    const server = await createVoiceWebSocketServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: () => session,
      contextId: () => "turn-test",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openClientAndReadReady(websocketUrl(address.port));
    const errorMessage = new Promise<any>((resolve) => {
      client.on("message", (data, isBinary) => {
        if (isBinary) return;
        const message = JSON.parse(data.toString());
        if (message.type === "error") resolve(message);
      });
    });

    client.send(JSON.stringify({
      type: "audio",
      contextId: "turn-fixed-rate",
      sampleRateHz: 48000,
      audio: Buffer.from(new Int16Array([0, 3000, 6000, 9000, 12000, 15000]).buffer).toString("base64"),
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.send(JSON.stringify({
      type: "audio",
      contextId: "turn-fixed-rate",
      sampleRateHz: 44100,
      audio: Buffer.from(new Int16Array([0, 1000, 2000, 3000]).buffer).toString("base64"),
    }));

    await expect(errorMessage).resolves.toMatchObject({
      type: "error",
      component: "transport",
      category: "invalid_input",
      message: "Websocket audio sampleRateHz changed within context turn-fixed-rate: 48000 -> 44100",
    });
    expect(received).toHaveLength(1);

    client.close();
    await server.close();
  });

  it("allows different JSON audio sample rates on different websocket contexts", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });

    const server = await createVoiceWebSocketServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: () => session,
      contextId: () => "turn-test",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openClientAndReadReady(websocketUrl(address.port));

    client.send(JSON.stringify({
      type: "audio",
      contextId: "turn-48k",
      sampleRateHz: 48000,
      audio: Buffer.from(new Int16Array([0, 3000, 6000, 9000, 12000, 15000]).buffer).toString("base64"),
    }));
    client.send(JSON.stringify({
      type: "audio",
      contextId: "turn-44k",
      sampleRateHz: 44100,
      audio: Buffer.from(new Int16Array([0, 2000, 4000, 6000]).buffer).toString("base64"),
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received.map((packet) => packet.contextId)).toEqual(["turn-48k", "turn-44k"]);

    client.close();
    await server.close();
  });

  it("records JSON audio sequence gaps without dropping monotonic frames", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    const metrics: ConversationMetricPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });
    session.bus.on("metric.conversation", (pkt) => {
      metrics.push(pkt as ConversationMetricPacket);
    });

    const server = await createVoiceWebSocketServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: () => session,
      contextId: () => "turn-test",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openClientAndReadReady(websocketUrl(address.port));
    const audio = Buffer.from(new Int16Array([0, 1000]).buffer).toString("base64");

    client.send(JSON.stringify({
      type: "audio",
      contextId: "turn-sequence-gap",
      sampleRateHz: 16000,
      sequence: 1,
      audio,
    }));
    client.send(JSON.stringify({
      type: "audio",
      contextId: "turn-sequence-gap",
      sampleRateHz: 16000,
      sequence: 4,
      audio,
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received).toHaveLength(2);
    expect(metrics).toContainEqual(expect.objectContaining({
      kind: "metric.conversation",
      contextId: "turn-sequence-gap",
      name: "websocket.audio_sequence_gap",
      value: JSON.stringify({ expected: 2, actual: 4, missed: 2 }),
    }));

    client.close();
    await server.close();
  });

  it("rejects duplicate JSON audio sequence numbers before forwarding the duplicate frame", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });

    const server = await createVoiceWebSocketServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: () => session,
      contextId: () => "turn-test",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openClientAndReadReady(websocketUrl(address.port));
    const errorMessage = new Promise<any>((resolve) => {
      client.on("message", (data, isBinary) => {
        if (isBinary) return;
        const message = JSON.parse(data.toString());
        if (message.type === "error") resolve(message);
      });
    });
    const audio = Buffer.from(new Int16Array([0, 1000]).buffer).toString("base64");

    client.send(JSON.stringify({
      type: "audio",
      contextId: "turn-sequence-duplicate",
      sampleRateHz: 16000,
      sequence: 2,
      audio,
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.send(JSON.stringify({
      type: "audio",
      contextId: "turn-sequence-duplicate",
      sampleRateHz: 16000,
      sequence: 2,
      audio,
    }));

    await expect(errorMessage).resolves.toMatchObject({
      type: "error",
      component: "transport",
      category: "invalid_input",
      message: "Websocket audio sequence must increase monotonically: 2 -> 2",
    });
    expect(received).toHaveLength(1);

    client.close();
    await server.close();
  });

  it("rejects malformed odd-byte PCM16 websocket audio without forwarding it", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });

    const server = await createVoiceWebSocketServer({
      port: 0,
      createSession: () => session,
      contextId: () => "turn-test",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openClientAndReadReady(websocketUrl(address.port));
    const errorMessage = new Promise<any>((resolve) => {
      client.on("message", (data, isBinary) => {
        if (isBinary) return;
        const message = JSON.parse(data.toString());
        if (message.type === "error") resolve(message);
      });
    });

    client.send(Buffer.from([1, 2, 3]));

    await expect(errorMessage).resolves.toMatchObject({
      type: "error",
      component: "transport",
      category: "invalid_input",
      message: "PCM16 audio payload must contain an even number of bytes",
    });
    expect(received).toEqual([]);

    client.close();
    await server.close();
  });

  it("rejects malformed base64 JSON audio without forwarding it", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });

    const server = await createVoiceWebSocketServer({
      port: 0,
      createSession: () => session,
      contextId: () => "turn-test",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openClientAndReadReady(websocketUrl(address.port));
    const errorMessage = new Promise<any>((resolve) => {
      client.on("message", (data, isBinary) => {
        if (isBinary) return;
        const message = JSON.parse(data.toString());
        if (message.type === "error") resolve(message);
      });
    });

    client.send(JSON.stringify({
      type: "audio",
      contextId: "turn-bad-base64",
      audio: "not base64",
    }));

    await expect(errorMessage).resolves.toMatchObject({
      type: "error",
      component: "transport",
      category: "invalid_input",
      message: "audio must be valid base64",
    });
    expect(received).toEqual([]);

    client.close();
    await server.close();
  });

  it("closes oversized inbound websocket messages before decoding or forwarding", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });

    const server = await createVoiceWebSocketServer({
      port: 0,
      maxInboundMessageBytes: 4,
      createSession: () => session,
      contextId: () => "turn-test",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openClientAndReadReady(websocketUrl(address.port));
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      client.once("close", (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
    });

    client.send(Buffer.from([1, 2, 3, 4, 5, 6]));

    await expect(closed).resolves.toEqual({
      code: 1009,
      reason: "websocket message too large",
    });
    expect(received).toEqual([]);

    await server.close();
  });

  it("accepts binary audio envelopes with turn and sample-rate metadata", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });

    const server = await createVoiceWebSocketServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: () => session,
      contextId: () => "turn-test",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openClientAndReadReady(websocketUrl(address.port));
    const samples48k = new Int16Array([0, 3000, 6000, 9000, 12000, 15000]);

    client.send(encodeTestBinaryAudioEnvelope({
      type: "audio",
      contextId: "turn-envelope",
      sampleRateHz: 48000,
      encoding: "pcm_s16le",
      channels: 1,
      byteLength: samples48k.byteLength,
      sequence: 7,
    }, new Uint8Array(samples48k.buffer)));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received).toEqual([
      expect.objectContaining({
        kind: "user.audio_received",
        contextId: "turn-envelope",
      }),
    ]);
    expect(Buffer.from(received[0]!.audio)).toEqual(Buffer.from(new Int16Array([0, 9000]).buffer));

    client.close();
    await server.close();
  });

  it("rejects binary audio envelopes that change sample rate inside the same websocket context", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });

    const server = await createVoiceWebSocketServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: () => session,
      contextId: () => "turn-test",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openClientAndReadReady(websocketUrl(address.port));
    const errorMessage = new Promise<any>((resolve) => {
      client.on("message", (data, isBinary) => {
        if (isBinary) return;
        const message = JSON.parse(data.toString());
        if (message.type === "error") resolve(message);
      });
    });

    client.send(encodeTestBinaryAudioEnvelope({
      type: "audio",
      contextId: "turn-envelope-rate",
      sampleRateHz: 48000,
      encoding: "pcm_s16le",
      channels: 1,
      byteLength: 12,
    }, new Uint8Array(new Int16Array([0, 3000, 6000, 9000, 12000, 15000]).buffer)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.send(encodeTestBinaryAudioEnvelope({
      type: "audio",
      contextId: "turn-envelope-rate",
      sampleRateHz: 44100,
      encoding: "pcm_s16le",
      channels: 1,
      byteLength: 8,
    }, new Uint8Array(new Int16Array([0, 1000, 2000, 3000]).buffer)));

    await expect(errorMessage).resolves.toMatchObject({
      type: "error",
      component: "transport",
      category: "invalid_input",
      message: "Websocket audio sampleRateHz changed within context turn-envelope-rate: 48000 -> 44100",
    });
    expect(received).toHaveLength(1);

    client.close();
    await server.close();
  });

  it("rejects regressing binary audio envelope sequence numbers", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });

    const server = await createVoiceWebSocketServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: () => session,
      contextId: () => "turn-test",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openClientAndReadReady(websocketUrl(address.port));
    const errorMessage = new Promise<any>((resolve) => {
      client.on("message", (data, isBinary) => {
        if (isBinary) return;
        const message = JSON.parse(data.toString());
        if (message.type === "error") resolve(message);
      });
    });
    const audio = new Uint8Array(new Int16Array([0, 1000]).buffer);

    client.send(encodeTestBinaryAudioEnvelope({
      type: "audio",
      contextId: "turn-envelope-sequence",
      sampleRateHz: 16000,
      encoding: "pcm_s16le",
      channels: 1,
      byteLength: audio.byteLength,
      sequence: 5,
    }, audio));
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.send(encodeTestBinaryAudioEnvelope({
      type: "audio",
      contextId: "turn-envelope-sequence",
      sampleRateHz: 16000,
      encoding: "pcm_s16le",
      channels: 1,
      byteLength: audio.byteLength,
      sequence: 4,
    }, audio));

    await expect(errorMessage).resolves.toMatchObject({
      type: "error",
      component: "transport",
      category: "invalid_input",
      message: "Websocket audio sequence must increase monotonically: 5 -> 4",
    });
    expect(received).toHaveLength(1);

    client.close();
    await server.close();
  });

  it("rejects enveloped audio without valid sample-rate metadata", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });

    const server = await createVoiceWebSocketServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: () => session,
      contextId: () => "turn-test",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openClientAndReadReady(websocketUrl(address.port));
    const errorMessage = new Promise<any>((resolve) => {
      client.on("message", (data, isBinary) => {
        if (isBinary) return;
        const message = JSON.parse(data.toString());
        if (message.type === "error") resolve(message);
      });
    });

    client.send(encodeTestBinaryAudioEnvelope({
      type: "audio",
      contextId: "turn-envelope",
      encoding: "pcm_s16le",
      channels: 1,
      byteLength: 4,
    }, new Uint8Array([1, 2, 3, 4])));

    await expect(errorMessage).resolves.toMatchObject({
      type: "error",
      component: "transport",
      category: "invalid_input",
      message: "Syrinx binary audio envelope sampleRateHz must be a positive integer",
    });
    expect(received).toEqual([]);

    client.close();
    await server.close();
  });

  it("rejects enveloped audio with inconsistent duration metadata", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });

    const server = await createVoiceWebSocketServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: () => session,
      contextId: () => "turn-test",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openClientAndReadReady(websocketUrl(address.port));
    const errorMessage = new Promise<any>((resolve) => {
      client.on("message", (data, isBinary) => {
        if (isBinary) return;
        const message = JSON.parse(data.toString());
        if (message.type === "error") resolve(message);
      });
    });

    client.send(encodeTestBinaryAudioEnvelope({
      type: "audio",
      contextId: "turn-envelope",
      sampleRateHz: 16000,
      encoding: "pcm_s16le",
      channels: 1,
      byteLength: 640,
      durationMs: 200,
    }, new Uint8Array(640)));

    await expect(errorMessage).resolves.toMatchObject({
      type: "error",
      component: "transport",
      category: "invalid_input",
      message: "Syrinx binary audio envelope durationMs does not match payload and sampleRateHz",
    });
    expect(received).toEqual([]);

    client.close();
    await server.close();
  });

  it("wraps outgoing assistant audio in the binary audio envelope by default", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = await createVoiceWebSocketServer({
      port: 0,
      outputSampleRateHz: 16000,
      createSession: () => session,
      contextId: () => "turn-test",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client, ready] = await openClientAndReadReady(websocketUrl(address.port));
    expect(ready.audio).toMatchObject({ binaryEnvelope: "syrinx.audio.v1" });

    const binaryMessage = new Promise<Buffer>((resolve) => {
      client.on("message", (data, isBinary) => {
        if (isBinary) resolve(data as Buffer);
      });
    });

    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "turn-tts",
      timestampMs: Date.now(),
      audio: new Uint8Array([1, 2, 3, 4]),
    });

    const envelope = decodeTestBinaryAudioEnvelope(await binaryMessage);
    expect(envelope.header).toMatchObject({
      type: "audio",
      contextId: "turn-tts",
      sequence: 1,
      sampleRateHz: 16000,
      encoding: "pcm_s16le",
      channels: 1,
      byteLength: 4,
    });
    expect(envelope.audio).toEqual(Buffer.from([1, 2, 3, 4]));

    client.close();
    await server.close();
  });

  it("can disable outgoing binary audio envelopes for raw PCM websocket clients", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = await createVoiceWebSocketServer({
      port: 0,
      outputSampleRateHz: 16000,
      binaryAudioEnvelope: false,
      createSession: () => session,
      contextId: () => "turn-test",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client, ready] = await openClientAndReadReady(websocketUrl(address.port));
    expect(ready.audio.binaryEnvelope).toBeUndefined();

    const binaryMessage = new Promise<Buffer>((resolve) => {
      client.on("message", (data, isBinary) => {
        if (isBinary) resolve(data as Buffer);
      });
    });

    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "turn-tts",
      timestampMs: Date.now(),
      audio: new Uint8Array([1, 2, 3, 4]),
    });

    expect(await binaryMessage).toEqual(Buffer.from([1, 2, 3, 4]));

    client.close();
    await server.close();
  });

  it("sends heartbeat pings so idle websocket peers are probed", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = await createVoiceWebSocketServer({
      port: 0,
      heartbeatIntervalMs: 10,
      createSession: () => session,
      contextId: () => "turn-test",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openClientAndReadReady(websocketUrl(address.port));
    const ping = new Promise<void>((resolve) => {
      client.once("ping", () => resolve());
    });

    await expect(ping).resolves.toBeUndefined();

    client.close();
    await server.close();
  });

  it("closes browser websocket sessions that exceed maxSessionDurationMs", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const closeSpy = vi.spyOn(session, "close");
    const server = await createVoiceWebSocketServer({
      port: 0,
      maxSessionDurationMs: 10,
      createSession: () => session,
      contextId: () => "turn-test",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openClientAndReadReady(websocketUrl(address.port));
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      client.once("close", (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
    });

    await expect(closed).resolves.toEqual({
      code: 1000,
      reason: "websocket max session duration exceeded",
    });
    await vi.waitFor(() => {
      expect(closeSpy).toHaveBeenCalled();
    });

    await server.close();
  });

  it("closes slow websocket consumers before assistant audio buffers grow unbounded", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = await createVoiceWebSocketServer({
      port: 0,
      maxBufferedAmountBytes: 4096,
      createSession: () => session,
      contextId: () => "turn-test",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openClientAndReadReady(websocketUrl(address.port));
    const serverSocket = [...server.wsServer.clients][0];
    if (!serverSocket) throw new Error("Expected server websocket");
    Object.defineProperty(serverSocket, "bufferedAmount", { configurable: true, value: 4097 });

    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      client.once("close", (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
    });
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "turn-tts",
      timestampMs: Date.now(),
      audio: new Uint8Array([1, 2, 3, 4]),
    });

    await expect(closed).resolves.toEqual({
      code: 1013,
      reason: "websocket send buffer exceeded",
    });

    await server.close();
  });

  it("closes websocket consumers before sending one oversized assistant audio frame", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = await createVoiceWebSocketServer({
      port: 0,
      maxBufferedAmountBytes: 4096,
      createSession: () => session,
      contextId: () => "turn-test",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openClientAndReadReady(websocketUrl(address.port));
    let receivedBinary = false;
    client.on("message", (_data, isBinary) => {
      if (isBinary) receivedBinary = true;
    });
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      client.once("close", (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
    });

    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "turn-tts",
      timestampMs: Date.now(),
      audio: new Uint8Array(8192),
    });

    await expect(closed).resolves.toEqual({
      code: 1013,
      reason: "websocket send buffer exceeded",
    });
    expect(receivedBinary).toBe(false);

    await server.close();
  });
});
