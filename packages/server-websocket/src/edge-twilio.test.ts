// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
  PipelineBusImpl,
  Route,
  type UserAudioReceivedPacket,
  type VoiceAgentSession,
} from "@kuralle-syrinx/core";
import {
  decodeMuLawToPcm16,
  encodePcm16ToMuLaw,
  pcm16BytesToSamples,
} from "@kuralle-syrinx/core/audio";
import type { ManagedSocket, SocketData } from "@kuralle-syrinx/ws";
import { InMemorySessionStore } from "./session-store.js";
import { runTwilioEdgeWebSocketConnection } from "./edge-twilio.js";

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
) {
  const socket = new FakeSocket();
  const session = fakeSession(received);
  await runTwilioEdgeWebSocketConnection(
    socket,
    new Request("https://edge.test/twilio?sessionId=tw1"),
    {
      sessionStore: new InMemorySessionStore(),
      createSession: () => session,
      keepAliveIntervalMs: 0,
      ...extraOptions,
    },
  );
  socket.emit(JSON.stringify({ event: "connected", protocol: "Call" }));
  socket.emit(JSON.stringify({
    event: "start",
    streamSid: "MZ123",
    start: { streamSid: "MZ123", callSid: "CA456" },
  }));
  return { socket, session };
}

describe("Twilio edge ingress", () => {
  it("decodes inbound mu-law media to 16k PCM user audio with a stable callSid context", async () => {
    const received: UserAudioReceivedPacket[] = [];
    const { socket } = await startConnection(received);

    const samples8k = new Int16Array(160).fill(8000); // 20ms at 8k
    const payload = bytesToBase64(encodePcm16ToMuLaw(samples8k));
    socket.emit(JSON.stringify({ event: "media", streamSid: "MZ123", media: { payload } }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(received).toHaveLength(1);
    expect(received[0]!.contextId).toBe("twilio-CA456");
    const pcm = pcm16BytesToSamples(received[0]!.audio);
    expect(pcm.length).toBe(320); // 8k → 16k doubles the samples
    expect(Math.abs(pcm[100]! - 8000)).toBeLessThan(600); // mu-law quantization tolerance
  });

  it("encodes engine TTS PCM to 8k mu-law media frames for Twilio", async () => {
    const { socket, session } = await startConnection();

    const pcm16k = new Int16Array(640).fill(6000); // 40ms at 16k
    const bytes = new Uint8Array(pcm16k.buffer.slice(0));
    session.bus.push(Route.Critical, {
      kind: "tts.audio",
      contextId: "twilio-CA456",
      timestampMs: Date.now(),
      audio: bytes,
      sampleRateHz: 16000,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const media = socket.json().filter((msg) => msg.event === "media");
    expect(media).toHaveLength(1);
    expect(media[0]!.streamSid).toBe("MZ123");
    const payload = (media[0]!.media as { payload: string }).payload;
    const decoded = decodeMuLawToPcm16(new Uint8Array(Buffer.from(payload, "base64")));
    expect(decoded.length).toBe(320); // 16k → 8k halves the samples
    expect(Math.abs(decoded[100]! - 6000)).toBeLessThan(600);
  });

  it("mixes the background bed (ducked) under TTS media", async () => {
    const { socket, session } = await startConnection([], {
      backgroundAudio: {
        ambient: { pcm: new Int16Array(320).fill(4000), sampleRateHz: 16000, gain: 0.5 },
        duckWhileSpeaking: 0.5,
        fadeMs: 0,
      },
      backgroundIdleFrameMs: 10_000, // keep the idle ticker out of this test
    });

    const silence = new Uint8Array(new Int16Array(640).buffer.slice(0)); // 40ms @16k of silence
    session.bus.push(Route.Critical, {
      kind: "tts.audio",
      contextId: "twilio-CA456",
      timestampMs: Date.now(),
      audio: silence,
      sampleRateHz: 16000,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const media = socket.json().filter((msg) => msg.event === "media");
    expect(media).toHaveLength(1);
    const payload = (media[0]!.media as { payload: string }).payload;
    const decoded = decodeMuLawToPcm16(new Uint8Array(Buffer.from(payload, "base64")));
    // ambient 4000 × gain 0.5 × duck 0.5 = 1000 under the silent speech
    expect(Math.abs(decoded[100]! - 1000)).toBeLessThan(120); // mu-law quantization tolerance
  });

  it("sends idle comfort-noise frames between turns", async () => {
    const { socket } = await startConnection([], {
      backgroundAudio: {
        ambient: { pcm: new Int16Array(320).fill(4000), sampleRateHz: 8000, gain: 0.5 },
        fadeMs: 0,
      },
      backgroundIdleFrameMs: 25,
    });

    await new Promise((resolve) => setTimeout(resolve, 120));

    const media = socket.json().filter((msg) => msg.event === "media");
    expect(media.length).toBeGreaterThanOrEqual(2); // ticker fills the silence
    const payload = (media[0]!.media as { payload: string }).payload;
    const decoded = decodeMuLawToPcm16(new Uint8Array(Buffer.from(payload, "base64")));
    // full-gain bed between turns: 4000 × 0.5 = 2000
    expect(Math.abs(decoded[10]! - 2000)).toBeLessThan(220);
    expect(decoded.length).toBe(200); // 25ms @ 8k
  });

  it("sends a clear event on interrupt.detected (barge-in)", async () => {
    const { socket, session } = await startConnection();

    session.bus.push(Route.Critical, {
      kind: "interrupt.detected",
      contextId: "twilio-CA456",
      timestampMs: Date.now(),
      source: "vad",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(socket.json()).toContainEqual({ event: "clear", streamSid: "MZ123" });
  });

  it("releases the session when Twilio sends stop", async () => {
    const { socket } = await startConnection();
    socket.emit(JSON.stringify({ event: "stop", streamSid: "MZ123" }));
    expect(socket.disposed).toBe(true);
  });

  it("actually closes the session on hangup (no provider-socket leak)", async () => {
    // Regression for the R1 leak: cleanup released without decrementing
    // connectionCount, so release early-returned and session.close() never ran —
    // Deepgram/TTS sockets leaked until DO eviction on every phone call.
    const socket = new FakeSocket();
    let closed = false;
    const bus = new PipelineBusImpl();
    const session = {
      bus,
      async start() { void bus.start(); },
      async close() { closed = true; bus.stop(); },
      on() {}, off() {}, requestClientInterrupt() {},
    } as unknown as VoiceAgentSession;

    await runTwilioEdgeWebSocketConnection(
      socket,
      new Request("https://edge.test/twilio?sessionId=tw-close"),
      { sessionStore: new InMemorySessionStore(), createSession: () => session, keepAliveIntervalMs: 0 },
    );
    socket.emit(JSON.stringify({ event: "start", streamSid: "MZ9", start: { streamSid: "MZ9", callSid: "CA9" } }));
    socket.emit(JSON.stringify({ event: "stop", streamSid: "MZ9" }));
    await new Promise((r) => setTimeout(r, 10));

    expect(closed).toBe(true);
  });

  it("rotates the uplink contextId after each completed turn", async () => {
    const received: UserAudioReceivedPacket[] = [];
    const { socket, session } = await startConnection(received);
    const payload = bytesToBase64(encodePcm16ToMuLaw(new Int16Array(160).fill(4000)));

    socket.emit(JSON.stringify({ event: "media", streamSid: "MZ123", media: { payload } }));
    session.bus.push(Route.Main, {
      kind: "eos.turn_complete",
      contextId: "twilio-CA456",
      timestampMs: Date.now(),
      text: "first turn",
      transcripts: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    socket.emit(JSON.stringify({ event: "media", streamSid: "MZ123", media: { payload } }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(received).toHaveLength(2);
    expect(received[0]!.contextId).toBe("twilio-CA456");
    expect(received[1]!.contextId).toBe("twilio-CA456-t1");
  });

  it("buffers start/media that arrive before the session lease resolves", async () => {
    const received: UserAudioReceivedPacket[] = [];
    const socket = new FakeSocket();
    const session = fakeSession(received);
    const run = runTwilioEdgeWebSocketConnection(
      socket,
      new Request("https://edge.test/twilio?sessionId=tw-early"),
      {
        sessionStore: new InMemorySessionStore(),
        createSession: async () => {
          await new Promise((resolve) => setTimeout(resolve, 30)); // slow startup
          return session;
        },
        keepAliveIntervalMs: 0,
      },
    );
    // Twilio talks immediately — before startup finishes.
    socket.emit(JSON.stringify({ event: "connected", protocol: "Call" }));
    socket.emit(JSON.stringify({
      event: "start",
      streamSid: "MZ9",
      start: { streamSid: "MZ9", callSid: "CA9" },
    }));
    const payload = bytesToBase64(encodePcm16ToMuLaw(new Int16Array(160).fill(4000)));
    socket.emit(JSON.stringify({ event: "media", streamSid: "MZ9", media: { payload } }));
    await run;
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(received).toHaveLength(1);
    expect(received[0]!.contextId).toBe("twilio-CA9");
  });
});
