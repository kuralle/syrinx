// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
  PipelineBusImpl,
  Route,
  encodeSyrinxAudioEnvelope,
  type Scheduler,
  type ScheduledCallback,
  type UserAudioReceivedPacket,
  type VoiceAgentSession,
} from "@kuralle-syrinx/core";
import { pcm16SamplesToBytes } from "@kuralle-syrinx/core/audio";
import type { ManagedSocket, SocketData } from "@kuralle-syrinx/ws";
import { InMemorySessionStore } from "./session-store.js";
import { runVoiceEdgeWebSocketConnection } from "./edge.js";

const KEEP_ALIVE_KEY = "voice.edge.keep_alive";

/** Scheduler whose tasks fire only when the test calls fire() — no real timers. */
class ManualScheduler implements Scheduler {
  readonly tasks = new Map<string, ScheduledCallback>();
  schedule(key: string, _delayMs: number, cb: ScheduledCallback): void {
    this.tasks.set(key, cb);
  }
  cancel(key: string): void {
    this.tasks.delete(key);
  }
  async fire(key: string): Promise<void> {
    const cb = this.tasks.get(key);
    this.tasks.delete(key);
    if (cb) await cb();
  }
}

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
  emit(data: SocketData, isBinary = false): void {
    this.#onMessage?.(data, isBinary);
  }
  json(): Array<Record<string, unknown>> {
    return this.sent
      .filter((s): s is string => typeof s === "string")
      .map((s) => JSON.parse(s) as Record<string, unknown>);
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

function runConnection(
  socket: FakeSocket,
  scheduler: ManualScheduler,
  opts: {
    idleTimeoutMs?: number;
    keepAliveIntervalMs?: number;
    rawBinaryInput?: boolean;
    received?: UserAudioReceivedPacket[];
  } = {},
) {
  const received = opts.received ?? [];
  return runVoiceEdgeWebSocketConnection(socket, new Request("https://edge.test/ws?sessionId=s1"), {
    sessionStore: new InMemorySessionStore(),
    scheduler,
    createSession: () => fakeSession(received),
    idleTimeoutMs: opts.idleTimeoutMs,
    keepAliveIntervalMs: opts.keepAliveIntervalMs,
    rawBinaryInput: opts.rawBinaryInput,
  });
}

function waitForReady(socket: FakeSocket): void {
  expect(socket.json().some((m) => m.type === "ready")).toBe(true);
}

function encodeEnvelopeFrame(
  sequence: number,
  audio: Uint8Array,
  contextId = "turn-envelope",
): Uint8Array {
  return encodeSyrinxAudioEnvelope({
    type: "audio",
    contextId,
    sampleRateHz: 16000,
    encoding: "pcm_s16le",
    channels: 1,
    byteLength: audio.byteLength,
    sequence,
  }, audio);
}

function findOddAndEvenEnvelopeFrames(
  pcm: Uint8Array,
): { ordered: [Uint8Array, Uint8Array]; odd: Uint8Array; even: Uint8Array } {
  const candidates: Array<{ frame: Uint8Array; parity: number; sequence: number }> = [];
  for (let index = 0; index < 32; index += 1) {
    const frame = encodeEnvelopeFrame(index + 1, pcm, `turn-envelope-${"x".repeat(index)}`);
    candidates.push({ frame, parity: frame.byteLength % 2, sequence: index + 1 });
  }
  const odd = candidates.find((entry) => entry.parity === 1);
  const even = candidates.find((entry) => entry.parity === 0 && entry.sequence > (odd?.sequence ?? 0));
  if (!odd || !even) throw new Error("Could not construct odd and even envelope frame lengths");
  const ordered = odd.sequence < even.sequence
    ? [odd.frame, even.frame] as [Uint8Array, Uint8Array]
    : [even.frame, odd.frame] as [Uint8Array, Uint8Array];
  return { ordered, odd: odd.frame, even: even.frame };
}

describe("edge keep-alive / idle close", () => {
  it("arms a keep-alive heartbeat once the session is ready and re-arms while active", async () => {
    const socket = new FakeSocket();
    const scheduler = new ManualScheduler();
    await runConnection(socket, scheduler, { idleTimeoutMs: 10_000, keepAliveIntervalMs: 1_000 });

    expect(socket.json().some((m) => m.type === "ready")).toBe(true);
    expect(scheduler.tasks.has(KEEP_ALIVE_KEY)).toBe(true);

    // A fresh heartbeat with recent client activity must re-arm, not close.
    await scheduler.fire(KEEP_ALIVE_KEY);
    expect(socket.disposed).toBe(false);
    expect(scheduler.tasks.has(KEEP_ALIVE_KEY)).toBe(true);
  });

  it("closes a half-open client that has been idle past idleTimeoutMs", async () => {
    const socket = new FakeSocket();
    const scheduler = new ManualScheduler();
    await runConnection(socket, scheduler, { idleTimeoutMs: 30, keepAliveIntervalMs: 1_000 });

    // No further client traffic; let the idle window elapse, then beat.
    await new Promise((r) => setTimeout(r, 60));
    await scheduler.fire(KEEP_ALIVE_KEY);

    expect(socket.disposed).toBe(true);
    expect(socket.json().some((m) => m.type === "error" && m.category === "idle_timeout")).toBe(true);
  });

  it("a client message resets the idle window", async () => {
    const socket = new FakeSocket();
    const scheduler = new ManualScheduler();
    await runConnection(socket, scheduler, { idleTimeoutMs: 30, keepAliveIntervalMs: 1_000 });

    await new Promise((r) => setTimeout(r, 60));
    socket.emit(JSON.stringify({ type: "ping" })); // refreshes lastClientMessageMs
    await scheduler.fire(KEEP_ALIVE_KEY);

    expect(socket.disposed).toBe(false);
    expect(scheduler.tasks.has(KEEP_ALIVE_KEY)).toBe(true);
  });

  it("keepAliveIntervalMs=0 disables the heartbeat entirely", async () => {
    const socket = new FakeSocket();
    const scheduler = new ManualScheduler();
    await runConnection(socket, scheduler, { keepAliveIntervalMs: 0 });

    expect(socket.json().some((m) => m.type === "ready")).toBe(true);
    expect(scheduler.tasks.has(KEEP_ALIVE_KEY)).toBe(false);
  });
});

describe("edge inbound binary audio envelopes", () => {
  it("decodes syrinx.audio.v1 envelopes into even PCM payloads", async () => {
    const received: UserAudioReceivedPacket[] = [];
    const socket = new FakeSocket();
    const scheduler = new ManualScheduler();
    await runConnection(socket, scheduler, { received });
    waitForReady(socket);

    const pcm = pcm16SamplesToBytes(new Int16Array([0, 32767, -32768, 16384]));
    const { ordered, odd: oddHeaderFrame, even: evenHeaderFrame } = findOddAndEvenEnvelopeFrames(pcm);
    expect(oddHeaderFrame.byteLength % 2).toBe(1);
    expect(evenHeaderFrame.byteLength % 2).toBe(0);

    for (const frame of ordered) socket.emit(frame, true);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received).toHaveLength(2);
    for (const packet of received) {
      expect(packet.kind).toBe("user.audio_received");
      expect(packet.contextId?.startsWith("turn-envelope")).toBe(true);
      expect(packet.audio.byteLength % 2).toBe(0);
      expect(packet.audio).toEqual(pcm);
    }
    expect(socket.json().some((m) => m.type === "error")).toBe(false);
  });

  it("rejects raw binary audio unless rawBinaryInput is enabled", async () => {
    const received: UserAudioReceivedPacket[] = [];
    const socket = new FakeSocket();
    const scheduler = new ManualScheduler();
    await runConnection(socket, scheduler, { received });
    waitForReady(socket);

    socket.emit(new Uint8Array([1, 2, 3, 4]), true);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received).toEqual([]);
    expect(socket.json()).toContainEqual({
      type: "error",
      component: "transport",
      category: "invalid_input",
      message: "Raw binary websocket audio is disabled; use syrinx.audio.v1 or JSON audio frames",
    });
  });
});

describe("edge barge-in downlink", () => {
  it("sends audio_clear and agent_interrupted when an interrupt is detected", async () => {
    const socket = new FakeSocket();
    const scheduler = new ManualScheduler();
    const session = fakeSession();
    await runVoiceEdgeWebSocketConnection(socket, new Request("https://edge.test/ws?sessionId=s1"), {
      sessionStore: new InMemorySessionStore(),
      scheduler,
      createSession: () => session,
    });
    waitForReady(socket);

    session.bus.push(Route.Critical, {
      kind: "interrupt.detected",
      contextId: "assistant-turn",
      timestampMs: Date.now(),
      source: "vad",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(socket.json()).toContainEqual({ type: "audio_clear", turnId: "assistant-turn", reason: "barge_in" });
    expect(socket.json()).toContainEqual({ type: "agent_interrupted", turnId: "assistant-turn", reason: "barge_in" });
  });
});
