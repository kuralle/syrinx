// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Decoder as OpusDecoder, Encoder as OpusEncoder } from "@evan/opus";
import { Route, VoiceAgentSession, type ConversationMetricPacket, type RecordAssistantAudioPacket, type UserAudioReceivedPacket } from "@asyncdot/voice";
import {
  createSmartPbxMediaStreamServer,
  encodePcm16ToMuLaw,
  pcm16BytesToSamples,
  pcm16SamplesToBytes,
} from "./index.js";

function smartPbxUrl(port: number): string {
  return `ws://127.0.0.1:${String(port)}/media-stream`;
}

async function openSocket(url: string): Promise<WebSocket> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < 1000) {
    const socket = new WebSocket(url);
    try {
      await new Promise<void>((resolveOpen, reject) => {
        socket.once("open", resolveOpen);
        socket.once("error", reject);
      });
      return socket;
    } catch (err) {
      socket.terminate();
      lastError = err;
      if (!(err instanceof Error) || !err.message.includes("Unexpected server response: 404")) throw err;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function readJsonMatching(socket: WebSocket, predicate: (message: any) => boolean): Promise<any> {
  return await new Promise((resolve) => {
    const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return;
      const message = JSON.parse(data.toString());
      if (!predicate(message)) return;
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}

async function readNthJsonMatching(socket: WebSocket, predicate: (message: any) => boolean, count: number): Promise<any> {
  return await new Promise((resolve) => {
    let seen = 0;
    const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return;
      const message = JSON.parse(data.toString());
      if (!predicate(message)) return;
      seen += 1;
      if (seen < count) return;
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}

function smartPbxStart(encoding = "g711_ulaw", sampleRate = 8000): Record<string, unknown> {
  return {
    event: "start",
    start: {
      callId: "call-test",
      otherLegCallId: "call-peer",
      callerIdNumber: "+94770000000",
      calleeIdNumber: "+94771111111",
      accountId: "account-test",
      mediaFormat: {
        encoding,
        sampleRate,
      },
    },
  };
}

describe("createSmartPbxMediaStreamServer", () => {
  it("decodes SmartPBX g711_ulaw media into engine PCM16", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });
    const server = await createSmartPbxMediaStreamServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: () => session,
      contextId: () => "smartpbx-call-test",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const client = await openSocket(smartPbxUrl(address.port));

    client.send(JSON.stringify(smartPbxStart()));
    client.send(JSON.stringify({
      event: "media",
      media: {
        payload: Buffer.from(encodePcm16ToMuLaw(new Int16Array([0, 1000, -1000, 3000]))).toString("base64"),
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received).toEqual([expect.objectContaining({ contextId: "smartpbx-call-test" })]);
    expect(received[0]!.audio.byteLength).toBe(16);

    client.close();
    await server.close();
  });

  it("buffers SmartPBX start and media sent before session startup completes", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });
    const server = await createSmartPbxMediaStreamServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return session;
      },
      contextId: () => "smartpbx-delayed-session",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const client = await openSocket(smartPbxUrl(address.port));

    client.send(JSON.stringify(smartPbxStart()));
    client.send(JSON.stringify({
      event: "media",
      media: {
        payload: Buffer.from(encodePcm16ToMuLaw(new Int16Array([0, 1000, -1000, 3000]))).toString("base64"),
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(received).toEqual([expect.objectContaining({ contextId: "smartpbx-delayed-session" })]);

    client.close();
    await server.close();
  });

  it("closes SmartPBX websocket connections when session startup exceeds startupTimeoutMs", async () => {
    const server = await createSmartPbxMediaStreamServer({
      port: 0,
      startupTimeoutMs: 10,
      createSession: () => new Promise<VoiceAgentSession>(() => undefined),
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const client = await openSocket(smartPbxUrl(address.port));
    const errorMessage = readJsonMatching(client, (message) => message.event === "syrinx_error");
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      client.once("close", (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
    });

    await expect(errorMessage).resolves.toMatchObject({
      event: "syrinx_error",
      error: {
        component: "transport",
      },
    });
    await expect(closed).resolves.toEqual({
      code: 1011,
      reason: "session initialization failed",
    });
    await server.close();
  });

  it("decodes SmartPBX little-endian pcm16 media and normalizes 24 kHz ingress", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });
    const server = await createSmartPbxMediaStreamServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const client = await openSocket(smartPbxUrl(address.port));

    client.send(JSON.stringify(smartPbxStart("pcm16", 24000)));
    client.send(JSON.stringify({
      event: "media",
      media: { payload: Buffer.from(pcm16SamplesToBytes(new Int16Array([100, 200, 300]))).toString("base64") },
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received[0]!.audio.byteLength).toBe(4);
    expect(Buffer.from(received[0]!.audio).readInt16LE(0)).toBe(100);

    client.close();
    await server.close();
  });

  it("emits assistant media with call identity in the selected SmartPBX wire codec", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = await createSmartPbxMediaStreamServer({
      port: 0,
      outputSampleRateHz: 16000,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const client = await openSocket(smartPbxUrl(address.port));

    client.send(JSON.stringify(smartPbxStart()));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const outbound = readJsonMatching(client, (message) => message.event === "media");
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "smartpbx-call-test",
      timestampMs: Date.now(),
      audio: pcm16SamplesToBytes(new Int16Array(320)),
      sampleRateHz: 16000,
    });

    await expect(outbound).resolves.toMatchObject({
      event: "media",
      callId: "call-test",
      accountId: "account-test",
    });
    const message = await outbound;
    expect(Buffer.from(message.media.payload, "base64").byteLength).toBe(160);

    client.close();
    await server.close();
  });

  it("emits pcm16 assistant media at SmartPBX 24 kHz when negotiated", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = await createSmartPbxMediaStreamServer({
      port: 0,
      outputSampleRateHz: 16000,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const client = await openSocket(smartPbxUrl(address.port));

    client.send(JSON.stringify(smartPbxStart("pcm16", 24000)));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const outbound = readJsonMatching(client, (message) => message.event === "media");
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "smartpbx-call-test",
      timestampMs: Date.now(),
      audio: pcm16SamplesToBytes(new Int16Array([1000, -1000, 500, -500])),
      sampleRateHz: 16000,
    });
    const media = await outbound;
    const bytes = Buffer.from(media.media.payload, "base64");

    expect(media).toMatchObject({ callId: "call-test", accountId: "account-test" });
    expect(bytes.readInt16LE(0)).toBe(1000);

    client.close();
    await server.close();
  });

  it("decodes SmartPBX opus media at 48 kHz into engine PCM16", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });
    const server = await createSmartPbxMediaStreamServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const client = await openSocket(smartPbxUrl(address.port));
    const encoder = new OpusEncoder({ channels: 1, sample_rate: 48000, application: "voip" });
    const samples48k = new Int16Array(960);
    samples48k[0] = 1000;
    samples48k[3] = -1000;
    const opus = encoder.encode(pcm16SamplesToBytes(samples48k));

    client.send(JSON.stringify(smartPbxStart("opus", 48000)));
    client.send(JSON.stringify({
      event: "media",
      media: { payload: Buffer.from(opus).toString("base64") },
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received).toEqual([expect.objectContaining({
      kind: "user.audio_received",
      contextId: "smartpbx-call-test",
    })]);
    expect(received[0]!.audio.byteLength).toBe(640);

    client.close();
    await server.close();
  });

  it("emits opus assistant media at SmartPBX 48 kHz when negotiated", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = await createSmartPbxMediaStreamServer({
      port: 0,
      outputSampleRateHz: 16000,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const client = await openSocket(smartPbxUrl(address.port));

    client.send(JSON.stringify(smartPbxStart("opus", 48000)));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const outbound = readJsonMatching(client, (message) => message.event === "media");
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "smartpbx-call-test",
      timestampMs: Date.now(),
      audio: pcm16SamplesToBytes(new Int16Array(320)),
      sampleRateHz: 16000,
    });
    const media = await outbound;
    const opus = Buffer.from(media.media.payload, "base64");
    const decoded = pcm16BytesToSamples(new OpusDecoder({ channels: 1, sample_rate: 48000 }).decode(opus));

    expect(media).toMatchObject({ callId: "call-test", accountId: "account-test" });
    expect(opus.byteLength).toBeGreaterThan(0);
    expect(decoded.length).toBe(960);

    client.close();
    await server.close();
  });

  it("flushes a partial SmartPBX opus assistant frame at TTS end", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = await createSmartPbxMediaStreamServer({
      port: 0,
      outputSampleRateHz: 16000,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const client = await openSocket(smartPbxUrl(address.port));

    client.send(JSON.stringify(smartPbxStart("opus", 48000)));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const outbound = readJsonMatching(client, (message) => message.event === "media");
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "smartpbx-call-test",
      timestampMs: Date.now(),
      audio: pcm16SamplesToBytes(new Int16Array(80)),
      sampleRateHz: 16000,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    session.bus.push(Route.Main, {
      kind: "tts.end",
      contextId: "smartpbx-call-test",
      timestampMs: Date.now(),
    });
    const media = await outbound;
    const decoded = pcm16BytesToSamples(new OpusDecoder({ channels: 1, sample_rate: 48000 }).decode(
      Buffer.from(media.media.payload, "base64"),
    ));

    expect(decoded.length).toBe(960);

    client.close();
    await server.close();
  });

  it("rejects unsupported SmartPBX opus sample rates before forwarding media", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });
    const server = await createSmartPbxMediaStreamServer({ port: 0, createSession: () => session });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const client = await openSocket(smartPbxUrl(address.port));
    const errorMessage = readJsonMatching(client, (message) => message.event === "syrinx_error");

    client.send(JSON.stringify(smartPbxStart("opus", 16000)));

    await expect(errorMessage).resolves.toMatchObject({
      error: { message: "Unsupported SmartPBX opus sample rate: 16000" },
    });
    expect(received).toEqual([]);

    client.close();
    await server.close();
  });

  it("rejects malformed SmartPBX base64 media payloads", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = await createSmartPbxMediaStreamServer({ port: 0, createSession: () => session });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const client = await openSocket(smartPbxUrl(address.port));
    const errorMessage = readJsonMatching(client, (message) => message.event === "syrinx_error");

    client.send(JSON.stringify(smartPbxStart()));
    client.send(JSON.stringify({ event: "media", media: { payload: "not base64" } }));

    await expect(errorMessage).resolves.toMatchObject({
      error: { message: "media.payload must be valid base64" },
    });

    client.close();
    await server.close();
  });

  it("treats SmartPBX hangup as a terminal stream boundary", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });
    const server = await createSmartPbxMediaStreamServer({
      port: 0,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const client = await openSocket(smartPbxUrl(address.port));
    const messages: any[] = [];
    client.on("message", (data, isBinary) => {
      if (!isBinary) messages.push(JSON.parse(data.toString()));
    });

    client.send(JSON.stringify(smartPbxStart()));
    client.send(JSON.stringify({ event: "hangup" }));
    client.send(JSON.stringify({
      event: "media",
      media: {
        payload: Buffer.from(encodePcm16ToMuLaw(new Int16Array([0, 1000, -1000, 3000]))).toString("base64"),
      },
    }));
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "smartpbx-call-test",
      timestampMs: Date.now(),
      audio: pcm16SamplesToBytes(new Int16Array(320)),
      sampleRateHz: 16000,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(received).toHaveLength(0);
    expect(messages.filter((message) => message.event === "media")).toHaveLength(0);

    client.close();
    await server.close();
  });

  it("cancels queued SmartPBX playout when the provider sends hangup", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const metrics: ConversationMetricPacket[] = [];
    const recording: RecordAssistantAudioPacket[] = [];
    let releaseMain: () => void = () => undefined;
    let notifyMainBlocked: () => void = () => undefined;
    const mainReleased = new Promise<void>((resolve) => {
      releaseMain = resolve;
    });
    const mainBlocked = new Promise<void>((resolve) => {
      notifyMainBlocked = resolve;
    });
    session.bus.on("metric.conversation", (pkt) => {
      metrics.push(pkt as ConversationMetricPacket);
    });
    session.bus.on("record.assistant_audio", (pkt) => {
      recording.push(pkt as RecordAssistantAudioPacket);
    });
    session.bus.on("user.audio_received", async () => {
      notifyMainBlocked();
      await mainReleased;
    });
    const server = await createSmartPbxMediaStreamServer({
      port: 0,
      outputSampleRateHz: 16000,
      outboundFrameDurationMs: 250,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const client = await openSocket(smartPbxUrl(address.port));
    const messages: any[] = [];
    client.on("message", (data) => messages.push(JSON.parse(data.toString())));

    client.send(JSON.stringify(smartPbxStart()));
    await new Promise((resolve) => setTimeout(resolve, 20));
    try {
      const firstMedia = readJsonMatching(client, (message) => message.event === "media");
      session.bus.push(Route.Main, {
        kind: "tts.audio",
        contextId: "smartpbx-call-test",
        timestampMs: Date.now(),
        audio: pcm16SamplesToBytes(new Int16Array(16000)),
        sampleRateHz: 16000,
      });
      await firstMedia;
      expect(messages.filter((message) => message.event === "media")).toHaveLength(1);

      client.send(JSON.stringify({
        event: "media",
        media: {
          payload: Buffer.from(encodePcm16ToMuLaw(new Int16Array([0, 1000, -1000, 3000]))).toString("base64"),
        },
      }));
      await mainBlocked;

      client.send(JSON.stringify({ event: "hangup" }));
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(messages.filter((message) => message.event === "media")).toHaveLength(1);
      expect(metrics).toContainEqual(expect.objectContaining({
        name: "smartpbx.stop_playout_cleared_ms",
        value: expect.stringMatching(/^[1-9]\d*$/),
      }));
      expect(recording).toContainEqual(expect.objectContaining({
        contextId: "smartpbx-call-test",
        truncate: true,
      }));
    } finally {
      releaseMain();
      client.close();
      await server.close();
    }
  });

  it("truncates queued SmartPBX playout when the websocket disconnects without hangup", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const metrics: ConversationMetricPacket[] = [];
    const recording: RecordAssistantAudioPacket[] = [];
    session.bus.on("metric.conversation", (pkt) => {
      metrics.push(pkt as ConversationMetricPacket);
    });
    session.bus.on("record.assistant_audio", (pkt) => {
      recording.push(pkt as RecordAssistantAudioPacket);
    });
    const server = await createSmartPbxMediaStreamServer({
      port: 0,
      outputSampleRateHz: 16000,
      outboundFrameDurationMs: 250,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const client = await openSocket(smartPbxUrl(address.port));
    client.send(JSON.stringify(smartPbxStart()));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const firstMedia = readJsonMatching(client, (message) => message.event === "media");
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "smartpbx-call-test",
      timestampMs: Date.now(),
      audio: pcm16SamplesToBytes(new Int16Array(16000)),
      sampleRateHz: 16000,
    });
    await firstMedia;
    client.terminate();
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(metrics).toContainEqual(expect.objectContaining({
      name: "smartpbx.disconnect_playout_cleared_ms",
      value: expect.stringMatching(/^[1-9]\d*$/),
    }));
    expect(recording).toContainEqual(expect.objectContaining({ truncate: true }));
    await server.close();
  });

  it("records local SmartPBX playout drain after the paced queue reaches tts.end", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const metrics: ConversationMetricPacket[] = [];
    session.bus.on("metric.conversation", (pkt) => {
      metrics.push(pkt as ConversationMetricPacket);
    });
    const server = await createSmartPbxMediaStreamServer({
      port: 0,
      outputSampleRateHz: 16000,
      outboundFrameDurationMs: 20,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const client = await openSocket(smartPbxUrl(address.port));
    client.send(JSON.stringify(smartPbxStart()));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const secondMedia = readNthJsonMatching(client, (message) => message.event === "media", 2);
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "smartpbx-call-test",
      timestampMs: Date.now(),
      audio: pcm16SamplesToBytes(new Int16Array(640)),
      sampleRateHz: 16000,
    });
    session.bus.push(Route.Main, {
      kind: "tts.end",
      contextId: "smartpbx-call-test",
      timestampMs: Date.now(),
    });

    await secondMedia;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(metrics).toContainEqual(expect.objectContaining({
      contextId: "smartpbx-call-test",
      name: "smartpbx.playout_drained",
      value: "1",
    }));
    expect(metrics).not.toContainEqual(expect.objectContaining({
      name: "smartpbx.stop_playout_cleared_ms",
    }));

    client.close();
    await server.close();
  });

  it("cancels unsent assistant audio locally without inventing a provider playback-clear command", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const metrics: ConversationMetricPacket[] = [];
    session.bus.on("metric.conversation", (pkt) => {
      metrics.push(pkt as ConversationMetricPacket);
    });
    const server = await createSmartPbxMediaStreamServer({
      port: 0,
      outputSampleRateHz: 16000,
      outboundFrameDurationMs: 20,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const client = await openSocket(smartPbxUrl(address.port));
    const sent: any[] = [];
    client.on("message", (data) => sent.push(JSON.parse(data.toString())));

    client.send(JSON.stringify(smartPbxStart()));
    await new Promise((resolve) => setTimeout(resolve, 10));
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "smartpbx-call-test",
      timestampMs: Date.now(),
      audio: pcm16SamplesToBytes(new Int16Array(1280)),
      sampleRateHz: 16000,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent.filter((message) => message.event === "media")).toHaveLength(1);
    session.bus.push(Route.Main, {
      kind: "interrupt.tts",
      contextId: "smartpbx-call-test",
      timestampMs: Date.now(),
      reason: "barge_in",
    });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(sent.filter((message) => message.event === "media")).toHaveLength(1);
    expect(sent.some((message) => message.event === "clear")).toBe(false);
    expect(metrics).toEqual([
      expect.objectContaining({ name: "smartpbx.interrupt_no_playback_clear" }),
    ]);

    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "smartpbx-call-test",
      timestampMs: Date.now(),
      audio: pcm16SamplesToBytes(new Int16Array(320)),
      sampleRateHz: 16000,
    });
    session.bus.push(Route.Main, {
      kind: "tts.end",
      contextId: "smartpbx-call-test",
      timestampMs: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(sent.filter((message) => message.event === "media")).toHaveLength(1);
    expect(metrics).toEqual([
      expect.objectContaining({ name: "smartpbx.interrupt_no_playback_clear" }),
    ]);

    client.close();
    await server.close();
  });

  it("sends heartbeat pings to SmartPBX websocket peers", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = await createSmartPbxMediaStreamServer({
      port: 0,
      heartbeatIntervalMs: 5,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const client = await openSocket(smartPbxUrl(address.port));
    let pinged = false;
    client.once("ping", () => {
      pinged = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pinged).toBe(true);

    client.close();
    await server.close();
  });

  it("closes SmartPBX websocket sessions that exceed maxSessionDurationMs", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = await createSmartPbxMediaStreamServer({
      port: 0,
      maxSessionDurationMs: 10,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const client = await openSocket(smartPbxUrl(address.port));
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      client.once("close", (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
    });

    await expect(closed).resolves.toEqual({
      code: 1000,
      reason: "websocket max session duration exceeded",
    });
    await server.close();
  });

  it("closes oversized SmartPBX inbound messages before parsing", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = await createSmartPbxMediaStreamServer({
      port: 0,
      maxInboundMessageBytes: 64,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const client = await openSocket(smartPbxUrl(address.port));
    const closed = new Promise<number>((resolve) => client.once("close", (code) => resolve(code)));
    client.send(JSON.stringify(smartPbxStart()));
    await expect(closed).resolves.toBe(1009);
    await server.close();
  });

  it("closes slow SmartPBX consumers before outbound buffers grow unbounded", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const metrics: ConversationMetricPacket[] = [];
    session.bus.on("metric.conversation", (pkt) => {
      metrics.push(pkt as ConversationMetricPacket);
    });
    const server = await createSmartPbxMediaStreamServer({
      port: 0,
      maxBufferedAmountBytes: 1,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const client = await openSocket(smartPbxUrl(address.port));
    client.send(JSON.stringify(smartPbxStart()));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const serverSocket = [...server.wsServer.clients][0]!;
    Object.defineProperty(serverSocket, "bufferedAmount", { value: 2, configurable: true });
    const closed = new Promise<number>((resolve) => client.once("close", (code) => resolve(code)));
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "smartpbx-call-test",
      timestampMs: Date.now(),
      audio: pcm16SamplesToBytes(new Int16Array(320)),
      sampleRateHz: 16000,
    });
    await expect(closed).resolves.toBe(1013);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(metrics).toContainEqual(expect.objectContaining({
      name: "smartpbx.send_buffer_playout_cleared_ms",
      value: "20",
    }));
    await server.close();
  });
});
