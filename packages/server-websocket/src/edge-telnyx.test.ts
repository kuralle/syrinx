// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
  PipelineBusImpl,
  Route,
  type UserAudioReceivedPacket,
  type VoiceAgentSession,
} from "@kuralle-syrinx/core";
import {
  decodeALawToPcm16,
  decodeMuLawToPcm16,
  encodePcm16ToALaw,
  encodePcm16ToMuLaw,
  pcm16BytesToSamples,
} from "@kuralle-syrinx/core/audio";
import type { ManagedSocket, SocketData } from "@kuralle-syrinx/ws";
import { InMemorySessionStore } from "./session-store.js";
import { runTelnyxEdgeWebSocketConnection } from "./edge-telnyx.js";
import {
  createTelnyxG722State,
  decodeTelnyxInboundPayload,
  encodeTelnyxOutboundPayload,
  validateTelnyxStart,
} from "./telnyx-codec.js";

class FakeSocket implements ManagedSocket {
  isOpen = true;
  disposed = false;
  readonly sent: SocketData[] = [];
  #onMessage?: (data: SocketData, isBinary: boolean) => void;
  #onClose?: (code: number, reason: string) => void;
  get isOpenValue(): boolean {
    return this.isOpen;
  }
  send(data: SocketData): void {
    this.sent.push(data);
  }
  keepAlivePing(): void {}
  async verify(): Promise<boolean> {
    return this.isOpen;
  }
  dispose(): void {
    this.disposed = true;
    this.isOpen = false;
    this.#onClose?.(1000, "disposed");
  }
  onOpen(): void {}
  onMessage(handler: (data: SocketData, isBinary: boolean) => void): void {
    this.#onMessage = handler;
  }
  onClose(handler: (code: number, reason: string) => void): void {
    this.#onClose = handler;
  }
  onError(): void {}
  emit(data: SocketData): void {
    this.#onMessage?.(data, false);
  }
  json(): Array<Record<string, unknown>> {
    return this.sent
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => JSON.parse(entry) as Record<string, unknown>);
  }
}

function fakeSession(received: UserAudioReceivedPacket[] = []): VoiceAgentSession {
  const bus = new PipelineBusImpl();
  bus.on("user.audio_received", (pkt) => {
    received.push(pkt as UserAudioReceivedPacket);
  });
  return {
    bus,
    async start() {
      void bus.start();
    },
    async close() {
      bus.stop();
    },
    on() {},
    off() {},
    requestClientInterrupt() {},
  } as unknown as VoiceAgentSession;
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

async function startConnection(
  received: UserAudioReceivedPacket[] = [],
  extraOptions: Record<string, unknown> = {},
  startOverrides: Record<string, unknown> = {},
) {
  const socket = new FakeSocket();
  const session = fakeSession(received);
  await runTelnyxEdgeWebSocketConnection(
    socket,
    new Request("https://edge.test/telnyx?sessionId=tx1"),
    {
      sessionStore: new InMemorySessionStore(),
      createSession: () => session,
      keepAliveIntervalMs: 0,
      ...extraOptions,
    },
  );
  socket.emit(JSON.stringify({ event: "connected", version: "1.0.0" }));
  socket.emit(JSON.stringify({
    event: "start",
    stream_id: "stream-123",
    start: {
      stream_id: "stream-123",
      call_control_id: "v3:ccid-456",
      media_format: { encoding: "PCMU", sample_rate: 8000, channels: 1 },
      ...startOverrides,
    },
  }));
  return { socket, session };
}

describe("telnyx-codec shared helpers", () => {
  it("round-trips PCMU and PCMA through encode/decode", () => {
    const samples = new Int16Array(160).fill(7000);
    for (const codec of ["PCMU", "PCMA"] as const) {
      const g722 = createTelnyxG722State(codec);
      const encoded = encodeTelnyxOutboundPayload(samples, codec, g722);
      const decoded = decodeTelnyxInboundPayload(encoded, codec, g722);
      expect(decoded.length).toBe(160);
      expect(Math.abs(decoded[50]! - 7000)).toBeLessThan(600);
    }
  });

  it("validateTelnyxStart accepts PCMA/G722 and rejects wrong rates", () => {
    expect(validateTelnyxStart({
      media_format: { encoding: "PCMA", sample_rate: 8000, channels: 1 },
    })).toEqual({ codec: "PCMA", sampleRateHz: 8000 });
    expect(validateTelnyxStart({
      media_format: { encoding: "G722", sample_rate: 16000, channels: 1 },
    })).toEqual({ codec: "G722", sampleRateHz: 16000 });
    expect(() => validateTelnyxStart({
      media_format: { encoding: "G722", sample_rate: 8000, channels: 1 },
    })).toThrow(/G722 sample rate/);
  });
});

describe("Telnyx edge ingress", () => {
  it("decodes inbound PCMU media to 16k PCM user audio with a stable call-control context", async () => {
    const received: UserAudioReceivedPacket[] = [];
    const { socket } = await startConnection(received);

    const samples8k = new Int16Array(160).fill(8000);
    const payload = bytesToBase64(encodePcm16ToMuLaw(samples8k));
    socket.emit(JSON.stringify({ event: "media", stream_id: "stream-123", media: { payload } }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(received).toHaveLength(1);
    expect(received[0]!.contextId).toBe("telnyx-v3:ccid-456");
    const pcm = pcm16BytesToSamples(received[0]!.audio);
    expect(pcm.length).toBe(320);
    expect(Math.abs(pcm[100]! - 8000)).toBeLessThan(600);
  });

  it("decodes inbound PCMA media to engine PCM", async () => {
    const received: UserAudioReceivedPacket[] = [];
    const { socket } = await startConnection(received, {}, {
      media_format: { encoding: "PCMA", sample_rate: 8000, channels: 1 },
    });

    const samples8k = new Int16Array(160).fill(5000);
    const payload = bytesToBase64(encodePcm16ToALaw(samples8k));
    socket.emit(JSON.stringify({ event: "media", media: { payload } }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(received).toHaveLength(1);
    const pcm = pcm16BytesToSamples(received[0]!.audio);
    expect(pcm.length).toBe(320);
    expect(Math.abs(pcm[100]! - 5000)).toBeLessThan(600);
  });

  it("encodes engine TTS PCM to 8k mu-law media frames for Telnyx", async () => {
    const { socket, session } = await startConnection();

    const pcm16k = new Int16Array(640).fill(6000);
    const bytes = new Uint8Array(pcm16k.buffer.slice(0));
    session.bus.push(Route.Critical, {
      kind: "tts.audio",
      contextId: "telnyx-v3:ccid-456",
      timestampMs: Date.now(),
      audio: bytes,
      sampleRateHz: 16000,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const media = socket.json().filter((msg) => msg.event === "media");
    expect(media).toHaveLength(1);
    const payload = (media[0]!.media as { payload: string }).payload;
    const decoded = decodeMuLawToPcm16(new Uint8Array(Buffer.from(payload, "base64")));
    expect(decoded.length).toBe(320);
    expect(Math.abs(decoded[100]! - 6000)).toBeLessThan(600);
  });

  it("encodes engine TTS to PCMA when the stream negotiated PCMA", async () => {
    const { socket, session } = await startConnection([], {}, {
      media_format: { encoding: "PCMA", sample_rate: 8000, channels: 1 },
    });

    const pcm16k = new Int16Array(640).fill(5500);
    session.bus.push(Route.Critical, {
      kind: "tts.audio",
      contextId: "telnyx-v3:ccid-456",
      timestampMs: Date.now(),
      audio: new Uint8Array(pcm16k.buffer.slice(0)),
      sampleRateHz: 16000,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const media = socket.json().filter((msg) => msg.event === "media");
    expect(media).toHaveLength(1);
    const payload = (media[0]!.media as { payload: string }).payload;
    const decoded = decodeALawToPcm16(new Uint8Array(Buffer.from(payload, "base64")));
    expect(decoded.length).toBe(320);
    expect(Math.abs(decoded[100]! - 5500)).toBeLessThan(600);
  });

  it("sends a clear event on interrupt.detected (barge-in)", async () => {
    const { socket, session } = await startConnection();

    session.bus.push(Route.Critical, {
      kind: "interrupt.detected",
      contextId: "telnyx-v3:ccid-456",
      timestampMs: Date.now(),
      source: "vad",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(socket.json()).toContainEqual({ event: "clear" });
  });

  it("releases the session when Telnyx sends stop", async () => {
    const { socket } = await startConnection();
    socket.emit(JSON.stringify({ event: "stop", stream_id: "stream-123" }));
    expect(socket.disposed).toBe(true);
  });

  it("actually closes the session on hangup (no provider-socket leak)", async () => {
    // Regression for the R1 leak: cleanup released without decrementing
    // connectionCount, so release early-returned and session.close() never ran.
    const socket = new FakeSocket();
    let closed = false;
    const bus = new PipelineBusImpl();
    const session = {
      bus,
      async start() { void bus.start(); },
      async close() { closed = true; bus.stop(); },
      on() {}, off() {}, requestClientInterrupt() {},
    } as unknown as VoiceAgentSession;

    await runTelnyxEdgeWebSocketConnection(
      socket,
      new Request("https://edge.test/telnyx?sessionId=tx-close"),
      { sessionStore: new InMemorySessionStore(), createSession: () => session, keepAliveIntervalMs: 0 },
    );
    socket.emit(JSON.stringify({
      event: "start",
      stream_id: "s9",
      start: {
        stream_id: "s9",
        call_control_id: "cc9",
        media_format: { encoding: "PCMU", sample_rate: 8000, channels: 1 },
      },
    }));
    socket.emit(JSON.stringify({ event: "stop", stream_id: "s9" }));
    await new Promise((r) => setTimeout(r, 10));

    expect(closed).toBe(true);
  });

  it("rotates the uplink contextId after each completed turn", async () => {
    const received: UserAudioReceivedPacket[] = [];
    const { socket, session } = await startConnection(received);
    const payload = bytesToBase64(encodePcm16ToMuLaw(new Int16Array(160).fill(4000)));

    socket.emit(JSON.stringify({ event: "media", media: { payload } }));
    session.bus.push(Route.Main, {
      kind: "eos.turn_complete",
      contextId: "telnyx-v3:ccid-456",
      timestampMs: Date.now(),
      text: "first turn",
      transcripts: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    socket.emit(JSON.stringify({ event: "media", media: { payload } }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(received).toHaveLength(2);
    expect(received[0]!.contextId).toBe("telnyx-v3:ccid-456");
    expect(received[1]!.contextId).toBe("telnyx-v3:ccid-456-t1");
  });

  it("buffers start/media that arrive before the session lease resolves", async () => {
    const received: UserAudioReceivedPacket[] = [];
    const socket = new FakeSocket();
    const session = fakeSession(received);
    const run = runTelnyxEdgeWebSocketConnection(
      socket,
      new Request("https://edge.test/telnyx?sessionId=tx-early"),
      {
        sessionStore: new InMemorySessionStore(),
        createSession: async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return session;
        },
        keepAliveIntervalMs: 0,
      },
    );
    socket.emit(JSON.stringify({ event: "connected", version: "1.0.0" }));
    socket.emit(JSON.stringify({
      event: "start",
      stream_id: "s-early",
      start: {
        stream_id: "s-early",
        call_control_id: "cc-early",
        media_format: { encoding: "PCMU", sample_rate: 8000, channels: 1 },
      },
    }));
    const payload = bytesToBase64(encodePcm16ToMuLaw(new Int16Array(160).fill(4000)));
    socket.emit(JSON.stringify({ event: "media", media: { payload } }));
    await run;
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(received).toHaveLength(1);
    expect(received[0]!.contextId).toBe("telnyx-cc-early");
  });
});
