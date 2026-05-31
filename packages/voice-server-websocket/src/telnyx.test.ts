// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Route, VoiceAgentSession, type ConversationMetricPacket, type RecordAssistantAudioPacket, type TextToSpeechPlayoutProgressPacket, type UserAudioReceivedPacket } from "@asyncdot/voice";
import { createTelnyxMediaStreamServer } from "./telnyx.js";
import { decodeMuLawToPcm16, encodePcm16ToMuLaw, pcm16SamplesToBytes, resamplePcm16 } from "@asyncdot/voice/audio";

function telnyxUrl(port: number): string {
  return `ws://127.0.0.1:${port}/telnyx`;
}

async function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolveOpen, reject) => {
    socket.once("open", resolveOpen);
    socket.once("error", reject);
  });
  return socket;
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

function telnyxStart(encoding = "PCMU", sampleRate = 8000): Record<string, unknown> {
  return {
    event: "start",
    stream_id: "telnyx-stream",
    start: {
      stream_id: "telnyx-stream",
      call_control_id: "call-control-test",
      media_format: {
        encoding,
        sample_rate: sampleRate,
        channels: 1,
      },
    },
  };
}

function bigEndianPcm16(samples: Int16Array): Uint8Array {
  const output = new Uint8Array(samples.byteLength);
  const view = new DataView(output.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(i * 2, samples[i]!, false);
  }
  return output;
}

describe("createTelnyxMediaStreamServer", () => {
  it("decodes Telnyx PCMU media frames into engine PCM16 audio packets", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });

    const server = await createTelnyxMediaStreamServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(telnyxUrl(address.port));
    const samples8k = new Int16Array([0, 1000, -1000, 3000]);
    const ulaw = encodePcm16ToMuLaw(samples8k);

    client.send(JSON.stringify(telnyxStart()));
    client.send(JSON.stringify({
      event: "media",
      stream_id: "telnyx-stream",
      media: {
        payload: Buffer.from(ulaw).toString("base64"),
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const decoded = decodeMuLawToPcm16(ulaw);
    const expected = pcm16SamplesToBytes(resamplePcm16(decoded, 8000, 16000));
    expect(received).toEqual([
      expect.objectContaining({
        kind: "user.audio_received",
        contextId: "telnyx-call-control-test",
      }),
    ]);
    expect(Buffer.from(received[0]!.audio)).toEqual(Buffer.from(expected));

    client.close();
    await server.close();
  });

  it("records Telnyx media chunk gaps after the bounded reorder window is exceeded", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    const metrics: ConversationMetricPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });
    session.bus.on("metric.conversation", (pkt) => {
      metrics.push(pkt as ConversationMetricPacket);
    });

    const server = await createTelnyxMediaStreamServer({
      port: 0,
      inputSampleRateHz: 16000,
      maxInboundReorderFrames: 1,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(telnyxUrl(address.port));
    const payload = Buffer.from(encodePcm16ToMuLaw(new Int16Array([0, 1000, -1000, 3000]))).toString("base64");

    client.send(JSON.stringify(telnyxStart()));
    client.send(JSON.stringify({
      event: "media",
      stream_id: "telnyx-stream",
      media: { chunk: "1", timestamp: "20", payload },
    }));
    client.send(JSON.stringify({
      event: "media",
      stream_id: "telnyx-stream",
      media: { chunk: "4", timestamp: "80", payload },
    }));
    client.send(JSON.stringify({
      event: "media",
      stream_id: "telnyx-stream",
      media: { chunk: "5", timestamp: "100", payload },
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received).toHaveLength(3);
    expect(metrics).toContainEqual(expect.objectContaining({
      kind: "metric.conversation",
      contextId: "telnyx-call-control-test",
      name: "telnyx.media_chunk_gap",
      value: JSON.stringify({ expected: 2, actual: 4, missed: 2 }),
    }));

    client.close();
    await server.close();
  });

  it("reorders out-of-order Telnyx media chunks before forwarding audio", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });

    const server = await createTelnyxMediaStreamServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(telnyxUrl(address.port));
    const chunk1 = bigEndianPcm16(new Int16Array([1, 2, 3, 4]));
    const chunk2 = bigEndianPcm16(new Int16Array([101, 102, 103, 104]));
    const chunk3 = bigEndianPcm16(new Int16Array([201, 202, 203, 204]));

    client.send(JSON.stringify(telnyxStart("L16", 16000)));
    client.send(JSON.stringify({
      event: "media",
      stream_id: "telnyx-stream",
      media: { chunk: "1", timestamp: "0", payload: Buffer.from(chunk1).toString("base64") },
    }));
    client.send(JSON.stringify({
      event: "media",
      stream_id: "telnyx-stream",
      media: { chunk: "3", timestamp: "40", payload: Buffer.from(chunk3).toString("base64") },
    }));
    client.send(JSON.stringify({
      event: "media",
      stream_id: "telnyx-stream",
      media: { chunk: "2", timestamp: "20", payload: Buffer.from(chunk2).toString("base64") },
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received).toHaveLength(3);
    expect(Buffer.from(received[0]!.audio)).toEqual(Buffer.from(pcm16SamplesToBytes(new Int16Array([1, 2, 3, 4]))));
    expect(Buffer.from(received[1]!.audio)).toEqual(Buffer.from(pcm16SamplesToBytes(new Int16Array([101, 102, 103, 104]))));
    expect(Buffer.from(received[2]!.audio)).toEqual(Buffer.from(pcm16SamplesToBytes(new Int16Array([201, 202, 203, 204]))));

    client.close();
    await server.close();
  });

  it("flushes buffered Telnyx media chunks when the websocket disconnects before stop", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    const metrics: ConversationMetricPacket[] = [];
    let closeCalls = 0;
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });
    session.bus.on("metric.conversation", (pkt) => {
      metrics.push(pkt as ConversationMetricPacket);
    });
    const originalClose = session.close.bind(session);
    session.close = async () => {
      closeCalls += 1;
      await originalClose();
    };

    const server = await createTelnyxMediaStreamServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(telnyxUrl(address.port));
    const chunk1 = bigEndianPcm16(new Int16Array([1, 2, 3, 4]));
    const chunk3 = bigEndianPcm16(new Int16Array([201, 202, 203, 204]));

    client.send(JSON.stringify(telnyxStart("L16", 16000)));
    client.send(JSON.stringify({
      event: "media",
      stream_id: "telnyx-stream",
      media: { chunk: "1", timestamp: "0", payload: Buffer.from(chunk1).toString("base64") },
    }));
    client.send(JSON.stringify({
      event: "media",
      stream_id: "telnyx-stream",
      media: { chunk: "3", timestamp: "40", payload: Buffer.from(chunk3).toString("base64") },
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toHaveLength(1);

    client.close();
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(closeCalls).toBeGreaterThan(0);
    expect(received).toHaveLength(2);
    expect(Buffer.from(received[1]!.audio)).toEqual(Buffer.from(pcm16SamplesToBytes(new Int16Array([201, 202, 203, 204]))));
    expect(metrics).toContainEqual(expect.objectContaining({
      kind: "metric.conversation",
      contextId: "telnyx-call-control-test",
      name: "telnyx.media_chunk_gap",
      value: JSON.stringify({ expected: 2, actual: 3, missed: 1 }),
    }));

    await server.close();
  });

  it("records Telnyx media timestamp gaps and regressions without dropping media", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    const metrics: ConversationMetricPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });
    session.bus.on("metric.conversation", (pkt) => {
      metrics.push(pkt as ConversationMetricPacket);
    });

    const server = await createTelnyxMediaStreamServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(telnyxUrl(address.port));
    const payload = Buffer.from(encodePcm16ToMuLaw(new Int16Array(160))).toString("base64");

    client.send(JSON.stringify(telnyxStart()));
    client.send(JSON.stringify({
      event: "media",
      stream_id: "telnyx-stream",
      media: { chunk: "1", timestamp: "0", payload },
    }));
    client.send(JSON.stringify({
      event: "media",
      stream_id: "telnyx-stream",
      media: { chunk: "2", timestamp: "60", payload },
    }));
    client.send(JSON.stringify({
      event: "media",
      stream_id: "telnyx-stream",
      media: { chunk: "3", timestamp: "40", payload },
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received).toHaveLength(3);
    expect(metrics).toContainEqual(expect.objectContaining({
      kind: "metric.conversation",
      contextId: "telnyx-call-control-test",
      name: "telnyx.media_timestamp_gap",
      value: JSON.stringify({ expected: 20, actual: 60, missedMs: 40 }),
    }));
    expect(metrics).toContainEqual(expect.objectContaining({
      kind: "metric.conversation",
      contextId: "telnyx-call-control-test",
      name: "telnyx.media_timestamp_regression",
      value: JSON.stringify({ previous: 60, actual: 40 }),
    }));

    client.close();
    await server.close();
  });

  it("rejects duplicate Telnyx media chunks before forwarding duplicate audio", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });

    const server = await createTelnyxMediaStreamServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(telnyxUrl(address.port));
    const errorMessage = readJsonMatching(client, (message) => message.event === "error" || message.event === "syrinx_error");
    const payload = Buffer.from(encodePcm16ToMuLaw(new Int16Array([0, 1000, -1000, 3000]))).toString("base64");

    client.send(JSON.stringify(telnyxStart()));
    client.send(JSON.stringify({
      event: "media",
      stream_id: "telnyx-stream",
      media: { chunk: "1", timestamp: "20", payload },
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.send(JSON.stringify({
      event: "media",
      stream_id: "telnyx-stream",
      media: { chunk: "1", timestamp: "20", payload },
    }));

    await expect(errorMessage).resolves.toMatchObject({
      event: "error",
      payload: {
        title: "syrinx_transport_error",
        detail: "Telnyx media.chunk is stale or duplicated: expected at least 2, received 1",
      },
    });
    expect(received).toHaveLength(1);

    client.close();
    await server.close();
  });

  it("records Telnyx top-level sequence_number gaps", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const metrics: ConversationMetricPacket[] = [];
    session.bus.on("metric.conversation", (pkt) => {
      metrics.push(pkt as ConversationMetricPacket);
    });

    const server = await createTelnyxMediaStreamServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(telnyxUrl(address.port));
    const payload = Buffer.from(encodePcm16ToMuLaw(new Int16Array([0, 1000, -1000, 3000]))).toString("base64");

    client.send(JSON.stringify({ ...telnyxStart(), sequence_number: "1" }));
    client.send(JSON.stringify({
      event: "media",
      sequence_number: "4",
      stream_id: "telnyx-stream",
      media: { chunk: "1", timestamp: "20", payload },
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(metrics).toContainEqual(expect.objectContaining({
      kind: "metric.conversation",
      contextId: "telnyx-call-control-test",
      name: "telnyx.sequence_gap",
      value: JSON.stringify({ expected: 2, actual: 4, missed: 2 }),
    }));

    client.close();
    await server.close();
  });

  it("records regressing Telnyx top-level sequence_number without dropping media", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    const metrics: ConversationMetricPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });
    session.bus.on("metric.conversation", (pkt) => {
      metrics.push(pkt as ConversationMetricPacket);
    });

    const server = await createTelnyxMediaStreamServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(telnyxUrl(address.port));
    const payload = Buffer.from(encodePcm16ToMuLaw(new Int16Array([0, 1000, -1000, 3000]))).toString("base64");

    client.send(JSON.stringify({ ...telnyxStart(), sequence_number: "1" }));
    client.send(JSON.stringify({
      event: "media",
      sequence_number: "3",
      stream_id: "telnyx-stream",
      media: { chunk: "1", timestamp: "20", payload },
    }));
    client.send(JSON.stringify({
      event: "media",
      sequence_number: "2",
      stream_id: "telnyx-stream",
      media: { chunk: "2", timestamp: "40", payload },
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received).toHaveLength(2);
    expect(metrics).toContainEqual(expect.objectContaining({
      kind: "metric.conversation",
      contextId: "telnyx-call-control-test",
      name: "telnyx.sequence_gap",
      value: JSON.stringify({ expected: 2, actual: 3, missed: 1 }),
    }));
    expect(metrics).toContainEqual(expect.objectContaining({
      kind: "metric.conversation",
      contextId: "telnyx-call-control-test",
      name: "telnyx.sequence_regression",
      value: JSON.stringify({ previous: 3, actual: 2 }),
    }));

    client.close();
    await server.close();
  });

  it("buffers Telnyx start and media sent before session startup completes", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });

    const server = await createTelnyxMediaStreamServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return session;
      },
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(telnyxUrl(address.port));
    const ulaw = encodePcm16ToMuLaw(new Int16Array([0, 1000, -1000, 3000]));
    client.send(JSON.stringify(telnyxStart()));
    client.send(JSON.stringify({
      event: "media",
      stream_id: "telnyx-stream",
      media: {
        payload: Buffer.from(ulaw).toString("base64"),
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(received).toEqual([
      expect.objectContaining({
        kind: "user.audio_received",
        contextId: "telnyx-call-control-test",
      }),
    ]);

    client.close();
    await server.close();
  });

  it("closes Telnyx websocket connections when session startup exceeds startupTimeoutMs", async () => {
    const server = await createTelnyxMediaStreamServer({
      port: 0,
      startupTimeoutMs: 10,
      createSession: () => new Promise<VoiceAgentSession>(() => undefined),
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(telnyxUrl(address.port));
    const errorMessage = readJsonMatching(client, (message) => message.event === "error");
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      client.once("close", (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
    });

    await expect(errorMessage).resolves.toEqual(expect.objectContaining({ event: expect.any(String) }));
    await expect(closed).resolves.toEqual({
      code: 1011,
      reason: "session initialization failed",
    });

    await server.close();
  });

  it("rejects unsupported Telnyx start media formats before forwarding audio", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });

    const server = await createTelnyxMediaStreamServer({
      port: 0,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(telnyxUrl(address.port));
    const errorMessage = readJsonMatching(client, (message) => message.event === "error");
    client.send(JSON.stringify(telnyxStart("PCMU", 16000)));

    await expect(errorMessage).resolves.toMatchObject({
      event: "error",
      payload: {
        title: "syrinx_transport_error",
        detail: "Unsupported Telnyx PCMU sample rate: 16000",
      },
    });
    expect(received).toEqual([]);

    client.close();
    await server.close();
  });

  it("decodes Telnyx L16 media into native engine PCM16", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });

    const server = await createTelnyxMediaStreamServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(telnyxUrl(address.port));
    const samples = new Int16Array([0, 1000, -1000, 3000]);
    client.send(JSON.stringify(telnyxStart("L16", 16000)));
    client.send(JSON.stringify({
      event: "media",
      stream_id: "telnyx-stream",
      media: {
        payload: Buffer.from(bigEndianPcm16(samples)).toString("base64"),
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(Buffer.from(received[0]!.audio)).toEqual(Buffer.from(pcm16SamplesToBytes(samples)));

    client.close();
    await server.close();
  });

  it("treats Telnyx stop as a terminal stream boundary", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });

    const server = await createTelnyxMediaStreamServer({
      port: 0,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(telnyxUrl(address.port));
    const messages: any[] = [];
    client.on("message", (data, isBinary) => {
      if (!isBinary) messages.push(JSON.parse(data.toString()));
    });

    client.send(JSON.stringify(telnyxStart()));
    client.send(JSON.stringify({ event: "stop", stream_id: "telnyx-stream" }));
    client.send(JSON.stringify({
      event: "media",
      stream_id: "telnyx-stream",
      media: {
        payload: Buffer.from(encodePcm16ToMuLaw(new Int16Array([0, 1000, -1000, 3000]))).toString("base64"),
      },
    }));
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "telnyx-call-control-test",
      timestampMs: Date.now(),
      audio: pcm16SamplesToBytes(new Int16Array(320)),
      sampleRateHz: 16000,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(received).toHaveLength(0);
    expect(messages.filter((message) => message.event === "media")).toHaveLength(0);
    expect(messages.filter((message) => message.event === "mark")).toHaveLength(0);
    expect(messages.filter((message) => message.event === "clear")).toHaveLength(0);

    client.close();
    await server.close();
  });

  it("cancels queued Telnyx playout when the provider sends stop", async () => {
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
    const server = await createTelnyxMediaStreamServer({
      port: 0,
      outputSampleRateHz: 16000,
      outboundFrameDurationMs: 250,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(telnyxUrl(address.port));
    const messages: any[] = [];
    client.on("message", (data, isBinary) => {
      if (!isBinary) messages.push(JSON.parse(data.toString()));
    });
    client.send(JSON.stringify(telnyxStart()));
    await new Promise((resolve) => setTimeout(resolve, 20));

    try {
      const firstMedia = readJsonMatching(client, (message) => message.event === "media");
      session.bus.push(Route.Main, {
        kind: "tts.audio",
        contextId: "telnyx-call-control-test",
        timestampMs: Date.now(),
        audio: pcm16SamplesToBytes(new Int16Array(16000)),
        sampleRateHz: 16000,
      });
      await firstMedia;
      expect(messages.filter((message) => message.event === "media")).toHaveLength(1);

      client.send(JSON.stringify({
        event: "media",
        stream_id: "telnyx-stream",
        media: {
          payload: Buffer.from(encodePcm16ToMuLaw(new Int16Array([0, 1000, -1000, 3000]))).toString("base64"),
        },
      }));
      await mainBlocked;

      client.send(JSON.stringify({ event: "stop", stream_id: "telnyx-stream" }));
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(messages.filter((message) => message.event === "media")).toHaveLength(1);
      expect(messages.filter((message) => message.event === "mark")).toHaveLength(0);
      expect(metrics).toContainEqual(expect.objectContaining({
        name: "telnyx.stop_playout_cleared_ms",
        value: expect.stringMatching(/^[1-9]\d*$/),
      }));
      expect(recording).toContainEqual(expect.objectContaining({
        contextId: "telnyx-call-control-test",
        truncate: true,
      }));
    } finally {
      releaseMain();
      client.close();
      await server.close();
    }
  });

  it("truncates queued Telnyx playout when the websocket disconnects without stop", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const metrics: ConversationMetricPacket[] = [];
    const recording: RecordAssistantAudioPacket[] = [];
    session.bus.on("metric.conversation", (pkt) => {
      metrics.push(pkt as ConversationMetricPacket);
    });
    session.bus.on("record.assistant_audio", (pkt) => {
      recording.push(pkt as RecordAssistantAudioPacket);
    });
    const server = await createTelnyxMediaStreamServer({
      port: 0,
      outputSampleRateHz: 16000,
      outboundFrameDurationMs: 250,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const client = await openSocket(telnyxUrl(address.port));
    client.send(JSON.stringify(telnyxStart()));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const firstMedia = readJsonMatching(client, (message) => message.event === "media");
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "telnyx-call-control-test",
      timestampMs: Date.now(),
      audio: pcm16SamplesToBytes(new Int16Array(16000)),
      sampleRateHz: 16000,
    });
    await firstMedia;
    client.terminate();
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(metrics).toContainEqual(expect.objectContaining({
      name: "telnyx.disconnect_playout_cleared_ms",
      value: expect.stringMatching(/^[1-9]\d*$/),
    }));
    expect(recording).toContainEqual(expect.objectContaining({ truncate: true }));
    await server.close();
  });

  it("encodes assistant PCM16 into default PCMU Telnyx media, marks playback, and clears on interruption", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = await createTelnyxMediaStreamServer({
      port: 0,
      outputSampleRateHz: 16000,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(telnyxUrl(address.port));
    client.send(JSON.stringify(telnyxStart()));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const mediaMessage = readJsonMatching(client, (message) => message.event === "media");
    const markMessage = readJsonMatching(client, (message) => message.event === "mark");
    const clearMessage = readJsonMatching(client, (message) => message.event === "clear");
    const samples16k = new Int16Array(320);
    for (let i = 0; i < samples16k.length; i += 1) samples16k[i] = i % 2 === 0 ? 1200 : -1200;

    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "telnyx-call-control-test",
      timestampMs: Date.now(),
      audio: pcm16SamplesToBytes(samples16k),
      sampleRateHz: 16000,
    });

    const media = await mediaMessage;
    expect(media).toEqual({
      event: "media",
      media: {
        payload: expect.any(String),
      },
    });
    expect(Buffer.from(media.media.payload, "base64")).toHaveLength(160);
    await expect(markMessage).resolves.toEqual({
      event: "mark",
      mark: {
        name: "telnyx-call-control-test:1",
      },
    });
    session.bus.push(Route.Critical, {
      kind: "interrupt.tts",
      contextId: "telnyx-call-control-test",
      timestampMs: Date.now(),
    });
    await expect(clearMessage).resolves.toEqual({
      event: "clear",
    });

    client.close();
    await server.close();
  });

  it("emits tts.playout_progress with completion after the paced audio drains", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = await createTelnyxMediaStreamServer({
      port: 0,
      outputSampleRateHz: 16000,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const progress: Array<{ playedOutMs: number; complete: boolean }> = [];
    session.bus.on("tts.playout_progress", (pkt) => {
      const p = pkt as TextToSpeechPlayoutProgressPacket;
      if (p.contextId === "telnyx-playout") progress.push({ playedOutMs: p.playedOutMs, complete: p.complete });
    });

    const client = await openSocket(telnyxUrl(address.port));
    client.send(JSON.stringify(telnyxStart()));
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 200ms of audio @ 16 kHz = 10 paced frames of 20ms.
    const samples = new Int16Array(3200);
    for (let i = 0; i < samples.length; i += 1) samples[i] = i % 2 === 0 ? 1200 : -1200;
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "telnyx-playout",
      timestampMs: Date.now(),
      audio: pcm16SamplesToBytes(samples),
      sampleRateHz: 16000,
    });
    session.bus.push(Route.Main, {
      kind: "tts.end",
      contextId: "telnyx-playout",
      timestampMs: Date.now(),
    });
    // Wait for the ~200ms of realtime pacing to drain, plus margin.
    await new Promise((resolve) => setTimeout(resolve, 340));

    const last = progress.at(-1);
    expect(last?.complete).toBe(true);
    expect(last?.playedOutMs).toBeGreaterThanOrEqual(180);

    client.close();
    await server.close();
  });

  it("uses configured L16 bidirectional output rather than assuming the inbound codec", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = await createTelnyxMediaStreamServer({
      port: 0,
      outputSampleRateHz: 16000,
      bidirectionalCodec: "L16",
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(telnyxUrl(address.port));
    client.send(JSON.stringify(telnyxStart("PCMU", 8000)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const mediaMessage = readJsonMatching(client, (message) => message.event === "media");
    const samples = new Int16Array(320);
    samples[0] = 0x1234;

    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "telnyx-call-control-test",
      timestampMs: Date.now(),
      audio: pcm16SamplesToBytes(samples),
      sampleRateHz: 16000,
    });

    const media = await mediaMessage;
    const bytes = Buffer.from(media.media.payload, "base64");
    expect(bytes).toHaveLength(640);
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0x12, 0x34]));

    client.close();
    await server.close();
  });

  it("paces outbound media and clears locally queued frames on interruption", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = await createTelnyxMediaStreamServer({
      port: 0,
      outputSampleRateHz: 16000,
      outboundFrameDurationMs: 20,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const client = await openSocket(telnyxUrl(address.port));
    const messages: any[] = [];
    client.on("message", (data, isBinary) => {
      if (!isBinary) messages.push(JSON.parse(data.toString()));
    });
    client.send(JSON.stringify(telnyxStart()));
    await new Promise((resolve) => setTimeout(resolve, 20));

    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "telnyx-call-control-test",
      timestampMs: Date.now(),
      audio: pcm16SamplesToBytes(new Int16Array(1280)),
      sampleRateHz: 16000,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(messages.filter((message) => message.event === "media")).toHaveLength(1);
    expect(messages.filter((message) => message.event === "mark")).toHaveLength(0);

    session.bus.push(Route.Critical, {
      kind: "interrupt.tts",
      contextId: "telnyx-call-control-test",
      timestampMs: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(messages.filter((message) => message.event === "media")).toHaveLength(1);
    expect(messages.filter((message) => message.event === "mark")).toHaveLength(0);
    expect(messages.filter((message) => message.event === "clear")).toHaveLength(1);

    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "telnyx-call-control-test",
      timestampMs: Date.now(),
      audio: pcm16SamplesToBytes(new Int16Array(320)),
      sampleRateHz: 16000,
    });
    session.bus.push(Route.Main, {
      kind: "tts.end",
      contextId: "telnyx-call-control-test",
      timestampMs: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(messages.filter((message) => message.event === "media")).toHaveLength(1);
    expect(messages.filter((message) => message.event === "mark")).toHaveLength(0);

    client.close();
    await server.close();
  });

  it("records Telnyx mark callbacks as playback acknowledgement metrics", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const metrics: ConversationMetricPacket[] = [];
    session.bus.on("metric.conversation", (pkt) => {
      metrics.push(pkt as ConversationMetricPacket);
    });

    const server = await createTelnyxMediaStreamServer({
      port: 0,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(telnyxUrl(address.port));
    client.send(JSON.stringify(telnyxStart()));
    await new Promise((resolve) => setTimeout(resolve, 20));

    client.send(JSON.stringify({
      event: "mark",
      stream_id: "telnyx-stream",
      mark: {
        name: "telnyx-call-control-test:1",
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(metrics).toEqual([
      expect.objectContaining({
        kind: "metric.conversation",
        contextId: "telnyx-call-control-test",
        name: "telnyx.mark_received",
        value: "telnyx-call-control-test:1",
      }),
    ]);

    client.close();
    await server.close();
  });

  it("sends the terminal Telnyx playback mark after pending playback marks are acknowledged", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = await createTelnyxMediaStreamServer({
      port: 0,
      outputSampleRateHz: 16000,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(telnyxUrl(address.port));
    client.send(JSON.stringify(telnyxStart()));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const playbackMark = readJsonMatching(client, (message) => message.event === "mark" && message.mark?.name === "telnyx-call-control-test:1");
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "telnyx-call-control-test",
      timestampMs: Date.now(),
      audio: pcm16SamplesToBytes(new Int16Array(320)),
      sampleRateHz: 16000,
    });
    const mark = await playbackMark;

    const endMark = readJsonMatching(client, (message) => message.event === "mark" && message.mark?.name === "telnyx-call-control-test:end");
    session.bus.push(Route.Main, {
      kind: "tts.end",
      contextId: "telnyx-call-control-test",
      timestampMs: Date.now(),
    });

    await expect(Promise.race([
      endMark.then(() => "end"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 30)),
    ])).resolves.toBe("pending");

    client.send(JSON.stringify({ event: "mark", stream_id: "telnyx-stream", mark: { name: mark.mark.name } }));
    await expect(endMark).resolves.toEqual({
      event: "mark",
      mark: {
        name: "telnyx-call-control-test:end",
      },
    });

    client.close();
    await server.close();
  });

  it("rejects malformed Telnyx base64 media payloads before forwarding audio", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });

    const server = await createTelnyxMediaStreamServer({
      port: 0,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(telnyxUrl(address.port));
    const errorMessage = readJsonMatching(client, (message) => message.event === "error");
    client.send(JSON.stringify(telnyxStart()));
    client.send(JSON.stringify({
      event: "media",
      stream_id: "telnyx-stream",
      media: {
        payload: "not base64",
      },
    }));

    await expect(errorMessage).resolves.toMatchObject({
      event: "error",
      payload: {
        title: "syrinx_transport_error",
        detail: "media.payload must be valid base64",
      },
    });
    expect(received).toEqual([]);

    client.close();
    await server.close();
  });

  it("rejects malformed Telnyx JSON media envelopes before forwarding audio", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });

    const server = await createTelnyxMediaStreamServer({
      port: 0,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(telnyxUrl(address.port));
    const errorMessage = readJsonMatching(client, (message) => message.event === "error");
    client.send(JSON.stringify(telnyxStart()));
    client.send(JSON.stringify({
      event: "media",
      stream_id: "telnyx-stream",
      media: "not an object",
    }));

    await expect(errorMessage).resolves.toMatchObject({
      event: "error",
      payload: {
        title: "syrinx_transport_error",
        detail: "Telnyx media must be a JSON object",
      },
    });
    expect(received).toEqual([]);

    client.close();
    await server.close();
  });

  it("sends heartbeat pings to Telnyx websocket peers", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = await createTelnyxMediaStreamServer({
      port: 0,
      heartbeatIntervalMs: 10,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(telnyxUrl(address.port));
    const ping = new Promise<void>((resolve) => {
      client.once("ping", () => resolve());
    });

    await expect(ping).resolves.toBeUndefined();

    client.close();
    await server.close();
  });

  it("closes Telnyx websocket sessions that exceed maxSessionDurationMs", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = await createTelnyxMediaStreamServer({
      port: 0,
      maxSessionDurationMs: 10,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(telnyxUrl(address.port));
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

  it("closes oversized inbound Telnyx websocket messages before parsing", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = await createTelnyxMediaStreamServer({
      port: 0,
      maxInboundMessageBytes: 8,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(telnyxUrl(address.port));
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      client.once("close", (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
    });

    client.send(JSON.stringify(telnyxStart()));

    await expect(closed).resolves.toEqual({
      code: 1009,
      reason: "websocket message too large",
    });

    await server.close();
  });

  it("closes slow Telnyx consumers before outbound media buffers grow unbounded", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const metrics: ConversationMetricPacket[] = [];
    session.bus.on("metric.conversation", (pkt) => {
      metrics.push(pkt as ConversationMetricPacket);
    });
    const server = await createTelnyxMediaStreamServer({
      port: 0,
      maxBufferedAmountBytes: 1,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(telnyxUrl(address.port));
    client.send(JSON.stringify(telnyxStart()));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const serverSocket = [...server.wsServer.clients][0];
    if (!serverSocket) throw new Error("Expected server websocket");
    Object.defineProperty(serverSocket, "bufferedAmount", { configurable: true, value: 2 });

    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      client.once("close", (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
    });
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "telnyx-call-control-test",
      timestampMs: Date.now(),
      audio: pcm16SamplesToBytes(new Int16Array(320)),
      sampleRateHz: 16000,
    });

    await expect(closed).resolves.toEqual({
      code: 1013,
      reason: "websocket send buffer exceeded",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(metrics).not.toContainEqual(expect.objectContaining({
      name: "telnyx.mark_sent",
    }));
    expect(metrics).toContainEqual(expect.objectContaining({
      name: "telnyx.send_buffer_playout_cleared_ms",
      value: "20",
    }));

    await server.close();
  });
});
