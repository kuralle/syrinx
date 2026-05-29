// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Route, VoiceAgentSession, type ConversationMetricPacket, type RecordAssistantAudioPacket, type UserAudioReceivedPacket } from "@asyncdot/voice";
import {
  createTwilioMediaStreamServer,
  decodeMuLawToPcm16,
  encodePcm16ToMuLaw,
  pcm16SamplesToBytes,
  resamplePcm16,
} from "./twilio.js";

function twilioUrl(port: number): string {
  return `ws://127.0.0.1:${port}/twilio`;
}

async function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolveOpen, reject) => {
    socket.once("open", resolveOpen);
    socket.once("error", reject);
  });
  return socket;
}

async function openSocketWithOptions(url: string, options: WebSocket.ClientOptions): Promise<WebSocket> {
  const socket = new WebSocket(url, options);
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

async function waitForCondition(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1000) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

function twilioStart(streamSid = "MZ-test-stream", callSid = "CA-test-call"): Record<string, unknown> {
  return {
    event: "start",
    streamSid,
    start: {
      streamSid,
      callSid,
      mediaFormat: {
        encoding: "audio/x-mulaw",
        sampleRate: 8000,
        channels: 1,
      },
    },
  };
}

describe("createTwilioMediaStreamServer", () => {
  it("does not negotiate websocket compression for carrier media streams", async () => {
    const server = await createTwilioMediaStreamServer({
      port: 0,
      createSession: () => new VoiceAgentSession({ plugins: {} }),
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocketWithOptions(twilioUrl(address.port), { perMessageDeflate: true });
    expect(client.extensions).toBe("");

    client.close();
    await server.close();
  });

  it("decodes Twilio PCMU media frames into engine PCM16 audio packets", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });

    const server = await createTwilioMediaStreamServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: () => session,
      contextId: () => "twilio-call-test",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(twilioUrl(address.port));
    const samples8k = new Int16Array([0, 1000, -1000, 3000]);
    const ulaw = encodePcm16ToMuLaw(samples8k);

    client.send(JSON.stringify({ event: "connected" }));
    client.send(JSON.stringify(twilioStart()));
    client.send(JSON.stringify({
      event: "media",
      streamSid: "MZ-test-stream",
      media: {
        track: "inbound",
        chunk: "1",
        timestamp: "20",
        payload: Buffer.from(ulaw).toString("base64"),
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const decoded = decodeMuLawToPcm16(ulaw);
    const expected = pcm16SamplesToBytes(resamplePcm16(decoded, 8000, 16000));
    expect(received).toEqual([
      expect.objectContaining({
        kind: "user.audio_received",
        contextId: "twilio-call-test",
      }),
    ]);
    expect(Buffer.from(received[0]!.audio)).toEqual(Buffer.from(expected));

    client.close();
    await server.close();
  });

  it("records Twilio media chunk gaps without dropping monotonic media", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    const metrics: ConversationMetricPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });
    session.bus.on("metric.conversation", (pkt) => {
      metrics.push(pkt as ConversationMetricPacket);
    });

    const server = await createTwilioMediaStreamServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: () => session,
      contextId: () => "twilio-gap-test",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(twilioUrl(address.port));
    const payload = Buffer.from(encodePcm16ToMuLaw(new Int16Array([0, 1000, -1000, 3000]))).toString("base64");

    client.send(JSON.stringify(twilioStart()));
    client.send(JSON.stringify({
      event: "media",
      streamSid: "MZ-test-stream",
      media: { track: "inbound", chunk: "1", timestamp: "20", payload },
    }));
    client.send(JSON.stringify({
      event: "media",
      streamSid: "MZ-test-stream",
      media: { track: "inbound", chunk: "4", timestamp: "80", payload },
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received).toHaveLength(2);
    expect(metrics).toContainEqual(expect.objectContaining({
      kind: "metric.conversation",
      contextId: "twilio-gap-test",
      name: "twilio.media_chunk_gap",
      value: JSON.stringify({ expected: 2, actual: 4, missed: 2 }),
    }));

    client.close();
    await server.close();
  });

  it("records Twilio media timestamp gaps and regressions without dropping media", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    const metrics: ConversationMetricPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });
    session.bus.on("metric.conversation", (pkt) => {
      metrics.push(pkt as ConversationMetricPacket);
    });

    const server = await createTwilioMediaStreamServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: () => session,
      contextId: () => "twilio-timestamp-test",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(twilioUrl(address.port));
    const payload = Buffer.from(encodePcm16ToMuLaw(new Int16Array(160))).toString("base64");

    client.send(JSON.stringify(twilioStart()));
    client.send(JSON.stringify({
      event: "media",
      streamSid: "MZ-test-stream",
      media: { track: "inbound", chunk: "1", timestamp: "0", payload },
    }));
    client.send(JSON.stringify({
      event: "media",
      streamSid: "MZ-test-stream",
      media: { track: "inbound", chunk: "2", timestamp: "60", payload },
    }));
    client.send(JSON.stringify({
      event: "media",
      streamSid: "MZ-test-stream",
      media: { track: "inbound", chunk: "3", timestamp: "40", payload },
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received).toHaveLength(3);
    expect(metrics).toContainEqual(expect.objectContaining({
      kind: "metric.conversation",
      contextId: "twilio-timestamp-test",
      name: "twilio.media_timestamp_gap",
      value: JSON.stringify({ expected: 20, actual: 60, missedMs: 40 }),
    }));
    expect(metrics).toContainEqual(expect.objectContaining({
      kind: "metric.conversation",
      contextId: "twilio-timestamp-test",
      name: "twilio.media_timestamp_regression",
      value: JSON.stringify({ previous: 60, actual: 40 }),
    }));

    client.close();
    await server.close();
  });

  it("rejects duplicate Twilio media chunks before forwarding duplicate audio", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });

    const server = await createTwilioMediaStreamServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: () => session,
      contextId: () => "twilio-duplicate-test",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(twilioUrl(address.port));
    const errorMessage = readJsonMatching(client, (message) => message.event === "syrinx_error");
    const payload = Buffer.from(encodePcm16ToMuLaw(new Int16Array([0, 1000, -1000, 3000]))).toString("base64");

    client.send(JSON.stringify(twilioStart()));
    client.send(JSON.stringify({
      event: "media",
      streamSid: "MZ-test-stream",
      media: { track: "inbound", chunk: "2", timestamp: "40", payload },
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.send(JSON.stringify({
      event: "media",
      streamSid: "MZ-test-stream",
      media: { track: "inbound", chunk: "2", timestamp: "40", payload },
    }));

    await expect(errorMessage).resolves.toMatchObject({
      event: "syrinx_error",
      error: {
        component: "transport",
        category: "invalid_input",
        message: "Twilio media.chunk must increase monotonically: 2 -> 2",
      },
    });
    expect(received).toHaveLength(1);

    client.close();
    await server.close();
  });

  it("records Twilio top-level sequenceNumber gaps", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const metrics: ConversationMetricPacket[] = [];
    session.bus.on("metric.conversation", (pkt) => {
      metrics.push(pkt as ConversationMetricPacket);
    });

    const server = await createTwilioMediaStreamServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: () => session,
      contextId: () => "twilio-sequence-gap-test",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(twilioUrl(address.port));
    const payload = Buffer.from(encodePcm16ToMuLaw(new Int16Array([0, 1000, -1000, 3000]))).toString("base64");

    client.send(JSON.stringify({ ...twilioStart(), sequenceNumber: "1" }));
    client.send(JSON.stringify({
      event: "media",
      sequenceNumber: "4",
      streamSid: "MZ-test-stream",
      media: { track: "inbound", chunk: "1", timestamp: "20", payload },
    }));
    await waitForCondition(() => metrics.some((metric) =>
      metric.contextId === "twilio-sequence-gap-test" &&
      metric.name === "twilio.sequence_gap",
    ));

    expect(metrics).toContainEqual(expect.objectContaining({
      kind: "metric.conversation",
      contextId: "twilio-sequence-gap-test",
      name: "twilio.sequence_gap",
      value: JSON.stringify({ expected: 2, actual: 4, missed: 2 }),
    }));

    client.close();
    await server.close();
  });

  it("rejects duplicate Twilio top-level sequenceNumber before forwarding duplicate audio", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });

    const server = await createTwilioMediaStreamServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: () => session,
      contextId: () => "twilio-sequence-duplicate-test",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(twilioUrl(address.port));
    const errorMessage = readJsonMatching(client, (message) => message.event === "syrinx_error");
    const payload = Buffer.from(encodePcm16ToMuLaw(new Int16Array([0, 1000, -1000, 3000]))).toString("base64");

    client.send(JSON.stringify({ ...twilioStart(), sequenceNumber: "1" }));
    client.send(JSON.stringify({
      event: "media",
      sequenceNumber: "2",
      streamSid: "MZ-test-stream",
      media: { track: "inbound", chunk: "1", timestamp: "20", payload },
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.send(JSON.stringify({
      event: "media",
      sequenceNumber: "2",
      streamSid: "MZ-test-stream",
      media: { track: "inbound", chunk: "2", timestamp: "40", payload },
    }));

    await expect(errorMessage).resolves.toMatchObject({
      event: "syrinx_error",
      error: {
        component: "transport",
        category: "invalid_input",
        message: "Twilio sequenceNumber must increase monotonically: 2 -> 2",
      },
    });
    expect(received).toHaveLength(1);

    client.close();
    await server.close();
  });

  it("buffers Twilio start and media sent before session startup completes", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });

    const server = await createTwilioMediaStreamServer({
      port: 0,
      inputSampleRateHz: 16000,
      createSession: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return session;
      },
      contextId: () => "twilio-delayed-session",
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(twilioUrl(address.port));
    const ulaw = encodePcm16ToMuLaw(new Int16Array([0, 1000, -1000, 3000]));
    client.send(JSON.stringify(twilioStart()));
    client.send(JSON.stringify({
      event: "media",
      streamSid: "MZ-test-stream",
      media: {
        track: "inbound",
        chunk: "1",
        timestamp: "20",
        payload: Buffer.from(ulaw).toString("base64"),
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(received).toEqual([
      expect.objectContaining({
        kind: "user.audio_received",
        contextId: "twilio-delayed-session",
      }),
    ]);

    client.close();
    await server.close();
  });

  it("closes Twilio websocket connections when session startup exceeds startupTimeoutMs", async () => {
    const server = await createTwilioMediaStreamServer({
      port: 0,
      startupTimeoutMs: 10,
      createSession: () => new Promise<VoiceAgentSession>(() => undefined),
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(twilioUrl(address.port));
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

  it("rejects unsupported Twilio start media formats before forwarding audio", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });

    const server = await createTwilioMediaStreamServer({
      port: 0,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(twilioUrl(address.port));
    const errorMessage = readJsonMatching(client, (message) => message.event === "syrinx_error");
    client.send(JSON.stringify({
      event: "start",
      streamSid: "MZ-test-stream",
      start: {
        streamSid: "MZ-test-stream",
        callSid: "CA-test-call",
        mediaFormat: {
          encoding: "audio/x-mulaw",
          sampleRate: 16000,
          channels: 1,
        },
      },
    }));

    await expect(errorMessage).resolves.toMatchObject({
      event: "syrinx_error",
      error: {
        component: "transport",
        category: "invalid_input",
        message: "Unsupported Twilio sample rate: 16000",
      },
    });
    expect(received).toEqual([]);

    client.close();
    await server.close();
  });

  it("rejects malformed Twilio base64 media payloads before forwarding audio", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });

    const server = await createTwilioMediaStreamServer({
      port: 0,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(twilioUrl(address.port));
    const errorMessage = readJsonMatching(client, (message) => message.event === "syrinx_error");
    client.send(JSON.stringify(twilioStart()));
    client.send(JSON.stringify({
      event: "media",
      streamSid: "MZ-test-stream",
      media: {
        payload: "not base64",
      },
    }));

    await expect(errorMessage).resolves.toMatchObject({
      event: "syrinx_error",
      error: {
        component: "transport",
        category: "invalid_input",
        message: "media.payload must be valid base64",
      },
    });
    expect(received).toEqual([]);

    client.close();
    await server.close();
  });

  it("treats Twilio stop as a terminal stream boundary", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const received: UserAudioReceivedPacket[] = [];
    session.bus.on("user.audio_received", (pkt) => {
      received.push(pkt as UserAudioReceivedPacket);
    });

    const server = await createTwilioMediaStreamServer({
      port: 0,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(twilioUrl(address.port));
    const messages: any[] = [];
    client.on("message", (data, isBinary) => {
      if (!isBinary) messages.push(JSON.parse(data.toString()));
    });

    client.send(JSON.stringify(twilioStart()));
    client.send(JSON.stringify({ event: "stop", streamSid: "MZ-test-stream" }));
    client.send(JSON.stringify({
      event: "media",
      streamSid: "MZ-test-stream",
      media: {
        track: "inbound",
        chunk: "2",
        timestamp: "40",
        payload: Buffer.from(encodePcm16ToMuLaw(new Int16Array([0, 1000, -1000, 3000]))).toString("base64"),
      },
    }));
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "twilio-CA-test-call",
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

  it("cancels queued Twilio playout when the provider sends stop", async () => {
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
    const server = await createTwilioMediaStreamServer({
      port: 0,
      outputSampleRateHz: 16000,
      outboundFrameDurationMs: 250,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(twilioUrl(address.port));
    const messages: any[] = [];
    client.on("message", (data, isBinary) => {
      if (!isBinary) messages.push(JSON.parse(data.toString()));
    });
    client.send(JSON.stringify(twilioStart()));
    await new Promise((resolve) => setTimeout(resolve, 20));

    try {
      const firstMedia = readJsonMatching(client, (message) => message.event === "media");
      session.bus.push(Route.Main, {
        kind: "tts.audio",
        contextId: "twilio-CA-test-call",
        timestampMs: Date.now(),
        audio: pcm16SamplesToBytes(new Int16Array(16000)),
        sampleRateHz: 16000,
      });
      await firstMedia;
      expect(messages.filter((message) => message.event === "media")).toHaveLength(1);

      client.send(JSON.stringify({
        event: "media",
        streamSid: "MZ-test-stream",
        media: {
          payload: Buffer.from(encodePcm16ToMuLaw(new Int16Array([0, 1000, -1000, 3000]))).toString("base64"),
        },
      }));
      await mainBlocked;

      client.send(JSON.stringify({ event: "stop", streamSid: "MZ-test-stream" }));
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(messages.filter((message) => message.event === "media")).toHaveLength(1);
      expect(messages.filter((message) => message.event === "mark")).toHaveLength(0);
      expect(metrics).toContainEqual(expect.objectContaining({
        name: "twilio.stop_playout_cleared_ms",
        value: expect.stringMatching(/^[1-9]\d*$/),
      }));
      expect(recording).toContainEqual(expect.objectContaining({
        contextId: "twilio-CA-test-call",
        truncate: true,
      }));
    } finally {
      releaseMain();
      client.close();
      await server.close();
    }
  });

  it("truncates queued Twilio playout when the websocket disconnects without stop", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const metrics: ConversationMetricPacket[] = [];
    const recording: RecordAssistantAudioPacket[] = [];
    session.bus.on("metric.conversation", (pkt) => {
      metrics.push(pkt as ConversationMetricPacket);
    });
    session.bus.on("record.assistant_audio", (pkt) => {
      recording.push(pkt as RecordAssistantAudioPacket);
    });
    const server = await createTwilioMediaStreamServer({
      port: 0,
      outputSampleRateHz: 16000,
      outboundFrameDurationMs: 250,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const client = await openSocket(twilioUrl(address.port));
    client.send(JSON.stringify(twilioStart()));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const firstMedia = readJsonMatching(client, (message) => message.event === "media");
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "twilio-CA-test-call",
      timestampMs: Date.now(),
      audio: pcm16SamplesToBytes(new Int16Array(16000)),
      sampleRateHz: 16000,
    });
    await firstMedia;
    client.terminate();
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(metrics).toContainEqual(expect.objectContaining({
      name: "twilio.disconnect_playout_cleared_ms",
      value: expect.stringMatching(/^[1-9]\d*$/),
    }));
    expect(recording).toContainEqual(expect.objectContaining({ truncate: true }));
    await server.close();
  });

  it("closes oversized inbound Twilio websocket messages before parsing", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = await createTwilioMediaStreamServer({
      port: 0,
      maxInboundMessageBytes: 8,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(twilioUrl(address.port));
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      client.once("close", (code, reason) => {
        resolve({ code, reason: reason.toString() });
      });
    });

    client.send(JSON.stringify(twilioStart()));

    await expect(closed).resolves.toEqual({
      code: 1009,
      reason: "websocket message too large",
    });

    await server.close();
  });

  it("encodes assistant PCM16 audio into 20 ms Twilio media frames, marks playback, and clears on interruption", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = await createTwilioMediaStreamServer({
      port: 0,
      outputSampleRateHz: 16000,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(twilioUrl(address.port));
    client.send(JSON.stringify(twilioStart()));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const mediaMessage = readJsonMatching(client, (message) => message.event === "media");
    const markMessage = readJsonMatching(client, (message) => message.event === "mark");
    const clearMessage = readJsonMatching(client, (message) => message.event === "clear");
    const samples16k = new Int16Array(320);
    for (let i = 0; i < samples16k.length; i += 1) {
      samples16k[i] = i % 2 === 0 ? 1200 : -1200;
    }

    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "twilio-CA-test-call",
      timestampMs: Date.now(),
      audio: pcm16SamplesToBytes(samples16k),
      sampleRateHz: 16000,
    });

    const media = await mediaMessage;
    expect(media).toMatchObject({
      event: "media",
      streamSid: "MZ-test-stream",
    });
    expect(Buffer.from(media.media.payload, "base64")).toHaveLength(160);
    await expect(markMessage).resolves.toEqual({
      event: "mark",
      streamSid: "MZ-test-stream",
      mark: {
        name: "twilio-CA-test-call:1",
      },
    });
    session.bus.push(Route.Critical, {
      kind: "interrupt.tts",
      contextId: "twilio-CA-test-call",
      timestampMs: Date.now(),
    });
    await expect(clearMessage).resolves.toEqual({
      event: "clear",
      streamSid: "MZ-test-stream",
    });

    client.close();
    await server.close();
  });

  it("paces outbound media frames and cancels unsent assistant audio on interruption", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = await createTwilioMediaStreamServer({
      port: 0,
      outputSampleRateHz: 16000,
      outboundFrameDurationMs: 20,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(twilioUrl(address.port));
    const messages: any[] = [];
    client.on("message", (data, isBinary) => {
      if (!isBinary) messages.push(JSON.parse(data.toString()));
    });
    client.send(JSON.stringify(twilioStart()));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const firstMedia = readJsonMatching(client, (message) => message.event === "media");
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "twilio-CA-test-call",
      timestampMs: Date.now(),
      audio: pcm16SamplesToBytes(new Int16Array(16000)),
      sampleRateHz: 16000,
    });
    await firstMedia;

    expect(messages.filter((message) => message.event === "media")).toHaveLength(1);
    expect(messages.filter((message) => message.event === "mark")).toHaveLength(0);

    session.bus.push(Route.Critical, {
      kind: "interrupt.tts",
      contextId: "twilio-CA-test-call",
      timestampMs: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(messages.filter((message) => message.event === "media")).toHaveLength(1);
    expect(messages.filter((message) => message.event === "mark")).toHaveLength(0);
    expect(messages.filter((message) => message.event === "clear")).toHaveLength(1);

    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "twilio-CA-test-call",
      timestampMs: Date.now(),
      audio: pcm16SamplesToBytes(new Int16Array(320)),
      sampleRateHz: 16000,
    });
    session.bus.push(Route.Main, {
      kind: "tts.end",
      contextId: "twilio-CA-test-call",
      timestampMs: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(messages.filter((message) => message.event === "media")).toHaveLength(1);
    expect(messages.filter((message) => message.event === "mark")).toHaveLength(0);

    client.close();
    await server.close();
  });

  it("records Twilio mark callbacks as playback acknowledgement metrics", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const metrics: ConversationMetricPacket[] = [];
    session.bus.on("metric.conversation", (pkt) => {
      metrics.push(pkt as ConversationMetricPacket);
    });

    const server = await createTwilioMediaStreamServer({
      port: 0,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(twilioUrl(address.port));
    client.send(JSON.stringify(twilioStart()));
    await new Promise((resolve) => setTimeout(resolve, 20));

    client.send(JSON.stringify({
      event: "mark",
      streamSid: "MZ-test-stream",
      mark: {
        name: "twilio-CA-test-call:1",
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(metrics).toEqual([
      expect.objectContaining({
        kind: "metric.conversation",
        contextId: "twilio-CA-test-call",
        name: "twilio.mark_received",
        value: "twilio-CA-test-call:1",
      }),
    ]);

    client.close();
    await server.close();
  });

  it("sends the terminal Twilio playback mark after pending playback marks are acknowledged", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = await createTwilioMediaStreamServer({
      port: 0,
      outputSampleRateHz: 16000,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(twilioUrl(address.port));
    client.send(JSON.stringify(twilioStart()));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const playbackMark = readJsonMatching(client, (message) => message.event === "mark" && message.mark?.name === "twilio-CA-test-call:1");
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "twilio-CA-test-call",
      timestampMs: Date.now(),
      audio: pcm16SamplesToBytes(new Int16Array(320)),
      sampleRateHz: 16000,
    });
    const mark = await playbackMark;

    const endMark = readJsonMatching(client, (message) => message.event === "mark" && message.mark?.name === "twilio-CA-test-call:end");
    session.bus.push(Route.Main, {
      kind: "tts.end",
      contextId: "twilio-CA-test-call",
      timestampMs: Date.now(),
    });

    await expect(Promise.race([
      endMark.then(() => "end"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 30)),
    ])).resolves.toBe("pending");

    client.send(JSON.stringify({ event: "mark", streamSid: "MZ-test-stream", mark: { name: mark.mark.name } }));
    await expect(endMark).resolves.toEqual({
      event: "mark",
      streamSid: "MZ-test-stream",
      mark: {
        name: "twilio-CA-test-call:end",
      },
    });

    client.close();
    await server.close();
  });

  it("closes when queued outbound audio exceeds the configured playout bound", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const metrics: ConversationMetricPacket[] = [];
    const recording: RecordAssistantAudioPacket[] = [];
    session.bus.on("metric.conversation", (pkt) => {
      metrics.push(pkt as ConversationMetricPacket);
    });
    session.bus.on("record.assistant_audio", (pkt) => {
      recording.push(pkt as RecordAssistantAudioPacket);
    });
    const server = await createTwilioMediaStreamServer({
      port: 0,
      outputSampleRateHz: 16000,
      outboundFrameDurationMs: 20,
      maxQueuedOutputAudioMs: 100,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    const client = await openSocket(twilioUrl(address.port));
    client.send(JSON.stringify(twilioStart()));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      client.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });

    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "twilio-CA-test-call",
      timestampMs: Date.now(),
      audio: pcm16SamplesToBytes(new Int16Array(1280)),
      sampleRateHz: 16000,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "twilio-CA-test-call",
      timestampMs: Date.now(),
      audio: pcm16SamplesToBytes(new Int16Array(1280)),
      sampleRateHz: 16000,
    });

    await expect(closed).resolves.toEqual({
      code: 1013,
      reason: "outbound audio queue exceeded",
    });
    expect(metrics).toContainEqual(expect.objectContaining({
      name: "twilio.overflow_playout_cleared_ms",
      value: "60",
    }));
    expect(recording).toContainEqual(expect.objectContaining({ truncate: true }));
    await server.close();
  });

  it("sends heartbeat pings to telephony websocket peers", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = await createTwilioMediaStreamServer({
      port: 0,
      heartbeatIntervalMs: 10,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(twilioUrl(address.port));
    const ping = new Promise<void>((resolve) => {
      client.once("ping", () => resolve());
    });

    await expect(ping).resolves.toBeUndefined();

    client.close();
    await server.close();
  });

  it("closes Twilio websocket sessions that exceed maxSessionDurationMs", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const server = await createTwilioMediaStreamServer({
      port: 0,
      maxSessionDurationMs: 10,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(twilioUrl(address.port));
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

  it("closes slow Twilio consumers before outbound media buffers grow unbounded", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const metrics: ConversationMetricPacket[] = [];
    session.bus.on("metric.conversation", (pkt) => {
      metrics.push(pkt as ConversationMetricPacket);
    });
    const server = await createTwilioMediaStreamServer({
      port: 0,
      maxBufferedAmountBytes: 1,
      createSession: () => session,
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const client = await openSocket(twilioUrl(address.port));
    client.send(JSON.stringify(twilioStart()));
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
      contextId: "twilio-CA-test-call",
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
      name: "twilio.mark_sent",
    }));
    expect(metrics).toContainEqual(expect.objectContaining({
      name: "twilio.send_buffer_playout_cleared_ms",
      value: "20",
    }));

    await server.close();
  });
});
