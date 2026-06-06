// SPDX-License-Identifier: MIT

import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  Route,
  VoiceAgentSession,
  type ConversationMetricPacket,
  type PipelineBus,
  type PluginConfig,
  type UserAudioReceivedPacket,
  type UserTextReceivedPacket,
  type VadAudioPacket,
  type VoicePlugin,
} from "@kuralle-syrinx/core";
import { Decoder as OpusDecoder, Encoder as OpusEncoder } from "@evan/opus";
import { pcm16BytesToSamples, pcm16SamplesToBytes } from "@kuralle-syrinx/core/audio";
import {
  createSmartPbxMediaStreamServer,
  createTelnyxMediaStreamServer,
  createTwilioMediaStreamServer,
  createVoiceWebSocketServer,
} from "./index.js";
import { BROWSER_OPUS_FRAME_DURATION_MS } from "./browser-opus.js";
import {
  openBrowserClientAndReadReady,
  openBrowserSocketReady,
  openSocket,
  readJson,
  readJsonMatching,
  registerHttpServer,
  registerServer,
  registerSocket,
  setupTransportTestCleanup,
  waitForClose,
  waitForCondition,
} from "./test-helpers.js";

setupTransportTestCleanup();

function websocketUrl(port: number): string {
  return `ws://127.0.0.1:${port}/ws`;
}

function websocketUrlWithSession(port: number, sessionId: string): string {
  return `ws://127.0.0.1:${port}/ws?sessionId=${encodeURIComponent(sessionId)}`;
}

const BINARY_AUDIO_ENVELOPE_MAGIC = Buffer.from("SYRXA1\n", "ascii");

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

class VadAlignmentProbe implements VoicePlugin {
  readonly observed: Array<{ contextId: string; byteOffsetParity: number; samples: number[] }> = [];
  private dispose: (() => void) | null = null;

  async initialize(bus: PipelineBus, _config: PluginConfig): Promise<void> {
    this.dispose = bus.on("vad.audio", (pkt) => {
      const audioPkt = pkt as VadAudioPacket;
      this.observed.push({
        contextId: audioPkt.contextId,
        byteOffsetParity: audioPkt.audio.byteOffset % 2,
        samples: Array.from(pcm16BytesToSamples(audioPkt.audio)),
      });
    });
  }

  async close(): Promise<void> {
    this.dispose?.();
    this.dispose = null;
  }
}

describe("createVoiceWebSocketServer", () => {
  it("routes multiple provider websocket paths on a shared HTTP server without handshake cross-talk", async () => {
    const httpServer = registerHttpServer(createServer());
    const [twilio, telnyx, smartpbx] = await Promise.all([
      registerServer(await createTwilioMediaStreamServer({
        server: httpServer,
        createSession: () => new VoiceAgentSession({ plugins: {} }),
      })),
      registerServer(await createTelnyxMediaStreamServer({
        server: httpServer,
        createSession: () => new VoiceAgentSession({ plugins: {} }),
      })),
      registerServer(await createSmartPbxMediaStreamServer({
        server: httpServer,
        createSession: () => new VoiceAgentSession({ plugins: {} }),
      })),
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
      openSocket(`ws://127.0.0.1:${String(address.port)}/twilio`, { perMessageDeflate: false }),
      openSocket(`ws://127.0.0.1:${String(address.port)}/telnyx`, { perMessageDeflate: false }),
      openSocket(`ws://127.0.0.1:${String(address.port)}/media-stream`, { perMessageDeflate: false }),
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
    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      createSession: () => new VoiceAgentSession({ plugins: {} }),
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(websocketUrl(address.port), { perMessageDeflate: true });
    expect(client.extensions).toBe("");

    client.close();
    await server.close();
  });

  it("rejects raw binary browser audio unless explicitly enabled", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });

    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      createSession: () => session,
      contextId: () => "turn-test",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client, ready] = await openBrowserClientAndReadReady(websocketUrl(address.port));
    expect(ready).toMatchObject({ type: "ready", turnId: "turn-test", resumed: false });
    expect(ready.audio.rawBinaryInput).toBe(false);
    // Ready frame advertises the target output frame duration so clients can size playout. (VE-01.3)
    expect(ready.audio.targetFrameDurationMs).toBe(20);
    const errorMessage = new Promise<any>((resolve) => {
      client.on("message", (data, isBinary) => {
        if (isBinary) return;
        const message = JSON.parse(data.toString());
        if (message.type === "error") resolve(message);
      });
    });

    client.send(Buffer.from([1, 2, 3, 4]));

    await expect(errorMessage).resolves.toMatchObject({
      type: "error",
      component: "transport",
      category: "invalid_input",
      message: "Raw binary websocket audio is disabled; use syrinx.audio.v1 or JSON audio frames",
    });
    expect(received).toEqual([]);

    client.close();
    await server.close();
  });

  it("bridges raw binary browser audio only when rawBinaryInput is enabled", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });

    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      rawBinaryInput: true,
      createSession: () => session,
      contextId: () => "turn-test",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client, ready] = await openBrowserClientAndReadReady(websocketUrl(address.port));
    expect(ready).toMatchObject({ type: "ready", turnId: "turn-test", resumed: false });
    expect(ready.sessionId).toMatch(/^session-/);
    expect(ready.maxSessionDurationMs).toBe(30 * 60_000);
    expect(ready.audio).toMatchObject({
      inputSampleRateHz: 16000,
      outputSampleRateHz: 16000,
      encoding: "opus",
      supportedInputCodecs: ["pcm_s16le", "opus"],
      channels: 1,
      binaryEnvelope: "syrinx.audio.v1",
      rawBinaryInput: true,
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

    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      createSession: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return session;
      },
      rawBinaryInput: true,
      contextId: () => "turn-early",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = registerSocket(new WebSocket(websocketUrl(address.port)));
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

    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      createSession: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return session;
      },
      rawBinaryInput: true,
      contextId: () => "turn-early",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = registerSocket(new WebSocket(websocketUrl(address.port)));
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
    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      startupTimeoutMs: 10,
      createSession: () => new Promise<VoiceAgentSession>(() => undefined),
      contextId: () => "turn-startup-timeout",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(websocketUrl(address.port));
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

    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      resumeWindowMs: 200,
      createSession: () => {
        created += 1;
        return session;
      },
      contextId: () => "turn-test",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [first, firstReady] = await openBrowserClientAndReadReady(websocketUrlWithSession(address.port, "resume-test"));
    expect(firstReady).toMatchObject({
      type: "ready",
      sessionId: "resume-test",
      resumed: false,
    });
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const [second, secondReady] = await openBrowserClientAndReadReady(websocketUrlWithSession(address.port, "resume-test"));
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

  it("keeps browser websocket audio format invariants across session resume", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      resumeWindowMs: 200,
      createSession: () => session,
      contextId: () => "turn-initial",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [first] = await openBrowserClientAndReadReady(websocketUrlWithSession(address.port, "resume-rate-test"));
    first.send(JSON.stringify({
      type: "audio",
      audio: Buffer.from([1, 0, 2, 0]).toString("base64"),
      contextId: "turn-resume-rate",
      sampleRateHz: 48000,
      sequence: 1,
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const [second, secondReady] = await openBrowserClientAndReadReady(websocketUrlWithSession(address.port, "resume-rate-test"));
    expect(secondReady).toMatchObject({
      type: "ready",
      sessionId: "resume-rate-test",
      turnId: "turn-resume-rate",
      resumed: true,
    });
    const errorMessage = new Promise<any>((resolve) => {
      second.on("message", (data, isBinary) => {
        if (isBinary) return;
        const message = JSON.parse(data.toString());
        if (message.type === "error") resolve(message);
      });
    });

    second.send(JSON.stringify({
      type: "audio",
      audio: Buffer.from([3, 0, 4, 0]).toString("base64"),
      contextId: "turn-resume-rate",
      sampleRateHz: 44100,
      sequence: 2,
    }));

    await expect(errorMessage).resolves.toMatchObject({
      type: "error",
      component: "transport",
      category: "invalid_input",
      message: "Websocket audio sampleRateHz changed within context turn-resume-rate: 48000 -> 44100",
    });

    second.close();
    await server.close();
  });

  it("keeps browser websocket audio sequence invariants across session resume", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      resumeWindowMs: 200,
      createSession: () => session,
      contextId: () => "turn-initial",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [first] = await openBrowserClientAndReadReady(websocketUrlWithSession(address.port, "resume-sequence-test"));
    first.send(JSON.stringify({
      type: "audio",
      audio: Buffer.from([1, 0, 2, 0]).toString("base64"),
      contextId: "turn-resume-sequence",
      sampleRateHz: 16000,
      sequence: 5,
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const [second, secondReady] = await openBrowserClientAndReadReady(websocketUrlWithSession(address.port, "resume-sequence-test"));
    expect(secondReady).toMatchObject({
      type: "ready",
      sessionId: "resume-sequence-test",
      turnId: "turn-resume-sequence",
      resumed: true,
    });
    const errorMessage = new Promise<any>((resolve) => {
      second.on("message", (data, isBinary) => {
        if (isBinary) return;
        const message = JSON.parse(data.toString());
        if (message.type === "error") resolve(message);
      });
    });

    second.send(JSON.stringify({
      type: "audio",
      audio: Buffer.from([3, 0, 4, 0]).toString("base64"),
      contextId: "turn-resume-sequence",
      sampleRateHz: 16000,
      sequence: 4,
    }));

    await expect(errorMessage).resolves.toMatchObject({
      type: "error",
      component: "transport",
      category: "invalid_input",
      message: "Websocket audio sequence must increase monotonically: 5 -> 4",
    });

    second.close();
    await server.close();
  });

  it("closes retained browser websocket sessions after the resume window expires", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const closeSpy = vi.spyOn(session, "close");

    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      resumeWindowMs: 10,
      createSession: () => session,
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openBrowserClientAndReadReady(websocketUrlWithSession(address.port, "expire-test"));
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

    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      createSession: () => session,
      contextId: () => "turn-test",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openBrowserClientAndReadReady(websocketUrl(address.port));

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
      sampleRateHz: 16000,
    });
    session.bus.push(Route.Main, {
      kind: "tts.end",
      contextId: "turn-2",
      timestampMs: Date.now(),
    });

    expect(textPackets).toEqual([
      expect.objectContaining({
        kind: "user.text_received",
        contextId: "turn-2",
        text: "hello",
      }),
    ]);
    await expect(metadataMessage).resolves.toMatchObject({
      type: "tts_chunk",
      turnId: "turn-2",
      sequence: 1,
      sampleRateHz: 16000,
      encoding: "opus",
      channels: 1,
    });
    const envelope = decodeTestBinaryAudioEnvelope(await audioMessage);
    expect(envelope.header).toMatchObject({
      type: "audio",
      contextId: "turn-2",
      sequence: 1,
      sampleRateHz: 16000,
      encoding: "opus",
    });
    expect(envelope.audio.byteLength).toBeGreaterThan(0);

    client.close();
    await server.close();
  });

  it("forwards VAD-driven assistant interruption as audio clear events", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      createSession: () => session,
      contextId: () => "turn-test",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openBrowserClientAndReadReady(websocketUrl(address.port));
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
    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      createSession: () => session,
      contextId: () => "turn-test",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openBrowserClientAndReadReady(websocketUrl(address.port));
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
      sampleRateHz: 16000,
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

  it("routes browser client_interrupt through the assistant interruption path", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      createSession: () => session,
      contextId: () => "turn-test",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openBrowserClientAndReadReady(websocketUrl(address.port));
    const messages: any[] = [];
    const binaries: Buffer[] = [];
    const metrics: ConversationMetricPacket[] = [];
    session.bus.on("metric.conversation", (pkt) => {
      metrics.push(pkt as ConversationMetricPacket);
    });
    client.on("message", (data, isBinary) => {
      if (isBinary) {
        binaries.push(Buffer.from(data as Buffer));
        return;
      }
      messages.push(JSON.parse(data.toString()));
    });

    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "assistant-turn",
      timestampMs: Date.now(),
      audio: new Uint8Array(1600),
      sampleRateHz: 16000,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    client.send(JSON.stringify({
      type: "client_interrupt",
      assistantContextId: "assistant-turn",
      reason: "local_vad_speech_start",
    }));
    await waitForCondition(() => messages.some((message) => message.type === "audio_clear"));
    binaries.length = 0;

    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "assistant-turn",
      timestampMs: Date.now(),
      audio: new Uint8Array([1, 2, 3, 4]),
      sampleRateHz: 16000,
    });
    session.bus.push(Route.Main, {
      kind: "tts.end",
      contextId: "assistant-turn",
      timestampMs: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "audio_clear", turnId: "assistant-turn", reason: "barge_in" }),
      expect.objectContaining({ type: "agent_interrupted", turnId: "assistant-turn", reason: "barge_in" }),
    ]));
    expect(metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "interrupt.committed_after_ms", value: "0" }),
    ]));
    expect(messages.some((message) => message.type === "tts_end")).toBe(false);
    expect(binaries).toEqual([]);

    client.close();
    await server.close();
  });

  it("forwards VAD speech boundary events to websocket clients", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      createSession: () => session,
      contextId: () => "turn-test",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openBrowserClientAndReadReady(websocketUrl(address.port));
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

    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: () => session,
      contextId: () => "turn-test",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openBrowserClientAndReadReady(websocketUrl(address.port));
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
    // FIR-resampled output: 48k→16k on a 6-sample ramp gives these weighted sums.
    expect(Buffer.from(received[0]!.audio)).toEqual(Buffer.from(new Int16Array([476, 10050]).buffer));

    client.close();
    await server.close();
  });

  it("rejects non-object websocket JSON messages before forwarding them", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const textPackets: UserTextReceivedPacket[] = [];
    const audioPackets: UserAudioReceivedPacket[] = [];
    session.bus.on("user.text_received", (pkt) => {
      textPackets.push(pkt as UserTextReceivedPacket);
    });
    session.bus.on("user.audio_received", (pkt) => {
      audioPackets.push(pkt as UserAudioReceivedPacket);
    });

    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      createSession: () => session,
      contextId: () => "turn-test",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openBrowserClientAndReadReady(websocketUrl(address.port));
    const errorMessage = new Promise<any>((resolve) => {
      client.on("message", (data, isBinary) => {
        if (isBinary) return;
        const message = JSON.parse(data.toString());
        if (message.type === "error") resolve(message);
      });
    });

    client.send("null");

    await expect(errorMessage).resolves.toMatchObject({
      type: "error",
      component: "transport",
      category: "invalid_input",
      message: "Websocket JSON message must be an object",
    });
    expect(textPackets).toEqual([]);
    expect(audioPackets).toEqual([]);

    client.close();
    await server.close();
  });

  it("rejects malformed websocket JSON text messages before forwarding them", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const textPackets: UserTextReceivedPacket[] = [];
    session.bus.on("user.text_received", (pkt) => {
      textPackets.push(pkt as UserTextReceivedPacket);
    });

    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      createSession: () => session,
      contextId: () => "turn-test",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openBrowserSocketReady(websocketUrl(address.port));
    const errorMessage = readJsonMatching(client, (message) => (message as { type?: string }).type === "error");

    client.send(JSON.stringify({ type: "text", text: 42, contextId: "turn-bad-text" }));

    await expect(errorMessage).resolves.toMatchObject({
      type: "error",
      component: "transport",
      category: "invalid_input",
      message: "Websocket JSON text must be a non-empty string",
    });
    expect(textPackets).toEqual([]);

    client.close();
    await server.close();
  });

  it("rejects malformed websocket JSON context identifiers before forwarding them", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });

    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      createSession: () => session,
      contextId: () => "turn-test",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openBrowserClientAndReadReady(websocketUrl(address.port));
    const errorMessage = new Promise<any>((resolve) => {
      client.on("message", (data, isBinary) => {
        if (isBinary) return;
        const message = JSON.parse(data.toString());
        if (message.type === "error") resolve(message);
      });
    });

    client.send(JSON.stringify({
      type: "audio",
      contextId: 123,
      sampleRateHz: 16000,
      audio: Buffer.from(new Int16Array([0, 1000]).buffer).toString("base64"),
    }));

    await expect(errorMessage).resolves.toMatchObject({
      type: "error",
      component: "transport",
      category: "invalid_input",
      message: "Websocket JSON contextId must be a non-empty string",
    });
    expect(received).toEqual([]);

    client.close();
    await server.close();
  });

  it("rejects JSON audio that changes sample rate inside the same websocket context", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });

    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: () => session,
      contextId: () => "turn-test",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openBrowserClientAndReadReady(websocketUrl(address.port));
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

    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: () => session,
      contextId: () => "turn-test",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openBrowserClientAndReadReady(websocketUrl(address.port));

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

    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: () => session,
      contextId: () => "turn-test",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openBrowserClientAndReadReady(websocketUrl(address.port));
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

    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: () => session,
      contextId: () => "turn-test",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openBrowserClientAndReadReady(websocketUrl(address.port));
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

    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      rawBinaryInput: true,
      createSession: () => session,
      contextId: () => "turn-test",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openBrowserClientAndReadReady(websocketUrl(address.port));
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

    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      createSession: () => session,
      contextId: () => "turn-test",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openBrowserClientAndReadReady(websocketUrl(address.port));
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
      sampleRateHz: 16000,
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

  it("rejects JSON audio without sample-rate metadata before forwarding it", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });

    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      createSession: () => session,
      contextId: () => "turn-test",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openBrowserClientAndReadReady(websocketUrl(address.port));
    const errorMessage = new Promise<any>((resolve) => {
      client.on("message", (data, isBinary) => {
        if (isBinary) return;
        const message = JSON.parse(data.toString());
        if (message.type === "error") resolve(message);
      });
    });

    client.send(JSON.stringify({
      type: "audio",
      contextId: "turn-missing-rate",
      audio: Buffer.from(new Int16Array([0, 1000]).buffer).toString("base64"),
    }));

    await expect(errorMessage).resolves.toMatchObject({
      type: "error",
      component: "transport",
      category: "invalid_input",
      message: "JSON websocket audio sampleRateHz must be a positive integer",
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

    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      maxInboundMessageBytes: 4,
      createSession: () => session,
      contextId: () => "turn-test",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openBrowserClientAndReadReady(websocketUrl(address.port));
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

    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: () => session,
      contextId: () => "turn-test",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openBrowserClientAndReadReady(websocketUrl(address.port));
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
    // FIR-resampled output: same algorithm as JSON path gives the same weighted sums.
    expect(Buffer.from(received[0]!.audio)).toEqual(Buffer.from(new Int16Array([476, 10050]).buffer));

    client.close();
    await server.close();
  });

  it("routes odd-offset binary envelope PCM through the session VAD branch", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const probe = new VadAlignmentProbe();
    session.registerPlugin("vad_alignment_probe", probe);
    const transportErrors: any[] = [];
    session.bus.on("pipeline.error", (pkt) => {
      transportErrors.push(pkt);
    });

    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: () => session,
      contextId: () => "turn-test",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openBrowserClientAndReadReady(websocketUrl(address.port));
    const audio = pcm16SamplesToBytes(new Int16Array([0, 32767, -32768, 16384]));
    const contexts = Array.from({ length: 8 }, (_, i) => `turn-envelope-vad-${"x".repeat(i)}`);
    for (const [index, contextId] of contexts.entries()) {
      client.send(encodeTestBinaryAudioEnvelope({
        type: "audio",
        contextId,
        sampleRateHz: 16000,
        encoding: "pcm_s16le",
        channels: 1,
        byteLength: audio.byteLength,
        sequence: index + 1,
      }, audio));
    }
    await waitForCondition(() => probe.observed.length === contexts.length, 500);

    expect(transportErrors).toEqual([]);
    const oddOffsetPacket = probe.observed.find((entry) => entry.byteOffsetParity === 1);
    expect(probe.observed.map((entry) => entry.byteOffsetParity)).toContain(1);
    expect(oddOffsetPacket?.samples).toEqual([0, 32767, -32768, 16384]);

    client.close();
    await server.close();
  });

  it("rejects binary audio envelopes that change sample rate inside the same websocket context", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });

    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: () => session,
      contextId: () => "turn-test",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openBrowserClientAndReadReady(websocketUrl(address.port));
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

    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: () => session,
      contextId: () => "turn-test",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openBrowserClientAndReadReady(websocketUrl(address.port));
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

    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: () => session,
      contextId: () => "turn-test",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openBrowserClientAndReadReady(websocketUrl(address.port));
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

    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: () => session,
      contextId: () => "turn-test",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openBrowserClientAndReadReady(websocketUrl(address.port));
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

  it("sends PCM downlink after client reports pcm codec capability", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      outputSampleRateHz: 16000,
      createSession: () => session,
      contextId: () => "turn-test",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openBrowserClientAndReadReady(websocketUrl(address.port));
    client.send(JSON.stringify({ type: "codec_capability", downlinkEncoding: "pcm_s16le" }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const binaryMessage = new Promise<Buffer>((resolve) => {
      client.on("message", (data, isBinary) => {
        if (isBinary) resolve(data as Buffer);
      });
    });

    const pcmFrame = new Uint8Array(640);
    pcmFrame.set([1, 2, 3, 4]);
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "turn-tts",
      timestampMs: Date.now(),
      audio: pcmFrame,
      sampleRateHz: 16000,
    });

    const envelope = decodeTestBinaryAudioEnvelope(await binaryMessage);
    expect(envelope.header).toMatchObject({
      encoding: "pcm_s16le",
      sampleRateHz: 16000,
    });
    expect(envelope.audio.byteLength).toBe(640);

    // The PCM-only browser decoder rejects odd payloads and a durationMs that does not
    // match round(bytes/2/rate*1000); the PCM downlink must satisfy both or playback
    // throws "PCM16 payload must contain an even number of bytes" / "durationMs mismatch".
    expect(envelope.audio.byteLength % 2).toBe(0);
    const expectedDurationMs = Math.round((envelope.audio.byteLength / 2 / 16000) * 1000);
    expect(Math.abs((envelope.header.durationMs ?? -1) - expectedDurationMs)).toBeLessThanOrEqual(1);

    client.close();
    await server.close();
  });

  it("wraps outgoing assistant audio in the binary audio envelope by default", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      outputSampleRateHz: 16000,
      createSession: () => session,
      contextId: () => "turn-test",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client, ready] = await openBrowserClientAndReadReady(websocketUrl(address.port));
    expect(ready.audio).toMatchObject({ binaryEnvelope: "syrinx.audio.v1" });

    const binaryMessage = new Promise<Buffer>((resolve) => {
      client.on("message", (data, isBinary) => {
        if (isBinary) resolve(data as Buffer);
      });
    });

    const pcmFrame = new Uint8Array(640);
    pcmFrame.set([1, 2, 3, 4]);
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "turn-tts",
      timestampMs: Date.now(),
      audio: pcmFrame,
      sampleRateHz: 16000,
    });

    const envelope = decodeTestBinaryAudioEnvelope(await binaryMessage);
    expect(envelope.header).toMatchObject({
      type: "audio",
      contextId: "turn-tts",
      sequence: 1,
      sampleRateHz: 16000,
      encoding: "opus",
      channels: 1,
    });
    expect(envelope.audio.byteLength).toBeGreaterThan(0);
    expect(envelope.header.byteLength).toBe(envelope.audio.byteLength);

    client.close();
    await server.close();
  });

  it("can disable outgoing binary audio envelopes for raw PCM websocket clients", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      outputSampleRateHz: 16000,
      binaryAudioEnvelope: false,
      createSession: () => session,
      contextId: () => "turn-test",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client, ready] = await openBrowserClientAndReadReady(websocketUrl(address.port));
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
      sampleRateHz: 16000,
    });

    expect(await binaryMessage).toEqual(Buffer.from([1, 2, 3, 4]));

    client.close();
    await server.close();
  });

  it("sends heartbeat pings so idle websocket peers are probed", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      heartbeatIntervalMs: 10,
      createSession: () => session,
      contextId: () => "turn-test",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openBrowserClientAndReadReady(websocketUrl(address.port));
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
    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      maxSessionDurationMs: 10,
      createSession: () => session,
      contextId: () => "turn-test",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openBrowserClientAndReadReady(websocketUrl(address.port));
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
    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      maxBufferedAmountBytes: 4096,
      createSession: () => session,
      contextId: () => "turn-test",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openBrowserClientAndReadReady(websocketUrl(address.port));
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
      audio: pcm16SamplesToBytes(new Int16Array(640)),
      sampleRateHz: 16000,
    });
    session.bus.push(Route.Main, {
      kind: "tts.end",
      contextId: "turn-tts",
      timestampMs: Date.now(),
    });

    await expect(closed).resolves.toEqual({
      code: 1013,
      reason: "websocket send buffer exceeded",
    });

    await server.close();
  });

  it("closes websocket consumers before sending one oversized assistant audio frame", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      maxBufferedAmountBytes: 4096,
      outboundFrameDurationMs: 300,
      maxQueuedOutputAudioMs: 1000,
      browserOpusDownlink: false,
      createSession: () => session,
      contextId: () => "turn-test",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openBrowserSocketReady(websocketUrl(address.port));
    let receivedBinary = false;
    client.on("message", (_data, isBinary) => {
      if (isBinary) receivedBinary = true;
    });
    let closeCode = -1;
    let closeReason = "";
    client.on("close", (code, reason) => {
      closeCode = code;
      closeReason = reason.toString();
    });

    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "turn-tts",
      timestampMs: Date.now(),
      audio: new Uint8Array(8192),
      sampleRateHz: 16000,
    });

    await waitForCondition(() => client.readyState === WebSocket.CLOSED);
    expect({ code: closeCode, reason: closeReason }).toEqual({
      code: 1013,
      reason: "websocket send buffer exceeded",
    });
    expect(receivedBinary).toBe(false);

    await server.close();
  });

  it("records a send_after_close metric and does not throw when tts.audio arrives after socket closes", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const metrics: ConversationMetricPacket[] = [];
    session.bus.on("metric.conversation", (pkt) => {
      metrics.push(pkt as ConversationMetricPacket);
    });

    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      createSession: () => session,
      contextId: () => "turn-test",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openBrowserClientAndReadReady(websocketUrl(address.port));
    const serverSocket = [...server.wsServer.clients][0]!;

    // terminate() sets readyState to CLOSING synchronously; the 'close' event (and disposer cleanup) fires asynchronously
    serverSocket.terminate();

    // Push tts.audio while the bus handler is still registered but socket is no longer OPEN — must not throw
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "turn-test",
      timestampMs: Date.now(),
      audio: new Uint8Array(32),
      sampleRateHz: 16000,
    });

    // Allow the close event to propagate
    await new Promise<void>((resolve) => client.once("close", resolve));

    expect(metrics.some((m) => m.name === "websocket.send_after_close")).toBe(true);

    await server.close();
  });

  it("decodes browser opus ingress into engine PCM16 and advertises supported codecs in ready", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });

    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      createSession: () => session,
      contextId: () => "turn-opus",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client, ready] = await openBrowserClientAndReadReady(websocketUrl(address.port));
    expect(ready.audio).toMatchObject({
      encoding: "opus",
      supportedInputCodecs: ["pcm_s16le", "opus"],
    });

    const pcm = new Int16Array(960);
    pcm[0] = 1000;
    pcm[3] = -1000;
    const encoder = new OpusEncoder({ channels: 1, sample_rate: 48000, application: "voip" });
    const opus = encoder.encode(pcm16SamplesToBytes(pcm));

    client.send(encodeTestBinaryAudioEnvelope({
      type: "audio",
      contextId: "turn-opus",
      sampleRateHz: 48000,
      sequence: 1,
      encoding: "opus",
      channels: 1,
      byteLength: opus.byteLength,
      durationMs: BROWSER_OPUS_FRAME_DURATION_MS,
    }, opus));

    await waitForCondition(() => received.length > 0, 2_000);
    expect(received[0]!.audio.byteLength).toBeGreaterThan(0);
    expect(received[0]!.audio.byteLength % 2).toBe(0);

    client.close();
    await server.close();
  });

  it("emits populated metrics after paced TTS playout completes", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      outboundFrameDurationMs: 20,
      createSession: () => session,
      contextId: () => "turn-test",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openBrowserClientAndReadReady(websocketUrl(address.port));
    const metricsMessage = readJsonMatching(client, (message) =>
      (message as { type?: string }).type === "metrics",
    );

    const speechEndMs = Date.now();
    session.bus.push(Route.Main, {
      kind: "vad.speech_ended",
      contextId: "metrics-turn",
      timestampMs: speechEndMs,
    });
    session.bus.push(Route.Main, {
      kind: "stt.result",
      contextId: "metrics-turn",
      timestampMs: speechEndMs + 200,
      text: "hello",
      confidence: 0.95,
    });
    session.bus.push(Route.Main, {
      kind: "llm.delta",
      contextId: "metrics-turn",
      timestampMs: speechEndMs + 500,
      text: "hi there",
    });

    const pcmFrame = pcm16SamplesToBytes(new Int16Array(640).fill(1000));
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "metrics-turn",
      timestampMs: speechEndMs + 700,
      audio: pcmFrame,
      sampleRateHz: 16000,
    });
    session.bus.push(Route.Main, {
      kind: "tts.end",
      contextId: "metrics-turn",
      timestampMs: speechEndMs + 710,
    });

    await expect(metricsMessage).resolves.toMatchObject({
      type: "metrics",
      turnId: "metrics-turn",
      correlationId: "metrics-turn",
      sttMs: 200,
      llmTTFTMs: 300,
      ttsTTFBMs: 200,
    });
    const metrics = await metricsMessage;
    expect(typeof (metrics as { e2eMs?: number }).e2eMs).toBe("number");
    expect((metrics as { firstAudioPlayedMs?: number }).firstAudioPlayedMs).toBeGreaterThan(0);
    expect((metrics as { lastAudioPlayedMs?: number }).lastAudioPlayedMs).toBeGreaterThan(0);

    client.close();
    await server.close();
  });

  it("notifies browser clients when the server commits the semantic turn", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      createSession: () => session,
      contextId: () => "turn-test",
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const [client] = await openBrowserClientAndReadReady(websocketUrl(address.port));
    const turnComplete = readJsonMatching(client, (message) =>
      (message as { type?: string }).type === "turn_complete",
    );

    session.bus.push(Route.Main, {
      kind: "eos.turn_complete",
      contextId: "semantic-turn",
      timestampMs: Date.now(),
      text: "I need help choosing modules.",
      transcripts: [],
    });

    await expect(turnComplete).resolves.toMatchObject({
      type: "turn_complete",
      turnId: "semantic-turn",
      transcript: "I need help choosing modules.",
    });

    client.close();
    await server.close();
  });
});
