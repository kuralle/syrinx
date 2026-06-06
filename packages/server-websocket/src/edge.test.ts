// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { PipelineBusImpl, type Scheduler, type ScheduledCallback, type VoiceAgentSession } from "@kuralle-syrinx/core";
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

function fakeSession(): VoiceAgentSession {
  const bus = new PipelineBusImpl();
  return {
    bus,
    async start() {},
    async close() {},
    on() {},
    off() {},
    requestClientInterrupt() {},
  } as unknown as VoiceAgentSession;
}

function runConnection(socket: FakeSocket, scheduler: ManualScheduler, opts: { idleTimeoutMs?: number; keepAliveIntervalMs?: number }) {
  return runVoiceEdgeWebSocketConnection(socket, new Request("https://edge.test/ws?sessionId=s1"), {
    sessionStore: new InMemorySessionStore(),
    scheduler,
    createSession: () => fakeSession(),
    idleTimeoutMs: opts.idleTimeoutMs,
    keepAliveIntervalMs: opts.keepAliveIntervalMs,
  });
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
