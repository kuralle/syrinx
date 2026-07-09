// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { PipelineBusImpl } from "./pipeline-bus.js";
import type { ConversationMetricPacket } from "./packets.js";
import type { Reasoner, ReasonerTurn, ReasoningPart } from "./reasoner.js";
import { HedgedReasoner } from "./reasoner-hedge.js";
import type { ScheduledCallback, Scheduler } from "./scheduler.js";

class FakeScheduler implements Scheduler {
  private readonly callbacks = new Map<string, ScheduledCallback>();

  schedule(key: string, _delayMs: number, cb: ScheduledCallback): void {
    this.callbacks.set(key, cb);
  }

  cancel(key: string): void {
    this.callbacks.delete(key);
  }

  fire(key: string): void {
    const cb = this.callbacks.get(key);
    if (!cb) return;
    this.callbacks.delete(key);
    void cb();
  }

  has(key: string): boolean {
    return this.callbacks.has(key);
  }
}

class ControllableReasoner implements Reasoner {
  streamInvoked = false;
  capturedSignal: AbortSignal | undefined;
  private deliver: ((part: ReasoningPart) => void) | null = null;

  stream(turn: ReasonerTurn): AsyncIterable<ReasoningPart> {
    this.streamInvoked = true;
    this.capturedSignal = turn.signal;
    const queue: ReasoningPart[] = [];
    let wake: (() => void) | null = null;

    this.deliver = (part: ReasoningPart) => {
      queue.push(part);
      wake?.();
      wake = null;
    };

    async function* generator(): AsyncGenerator<ReasoningPart> {
      while (!turn.signal.aborted) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            if (turn.signal.aborted) {
              resolve();
              return;
            }
            wake = resolve;
            turn.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        if (turn.signal.aborted) return;
        const part = queue.shift();
        if (part === undefined) return;
        yield part;
        if (part.type === "error" || part.type === "suspended" || part.type === "finish") return;
      }
    }

    return generator();
  }

  emit(part: ReasoningPart): void {
    this.deliver?.(part);
  }
}

function baseTurn(signal = new AbortController().signal): ReasonerTurn {
  return { userText: "hi", messages: [{ role: "user", content: "hi" }], signal };
}

async function collect(reasoner: Reasoner, turn: ReasonerTurn): Promise<ReasoningPart[]> {
  const parts: ReasoningPart[] = [];
  for await (const part of reasoner.stream(turn)) {
    parts.push(part);
  }
  return parts;
}

function silentReasoner(hook?: (turn: ReasonerTurn) => void): Reasoner {
  return {
    stream(turn) {
      hook?.(turn);
      return (async function*() {
        await new Promise<void>(() => {});
      })();
    },
  };
}

function scriptedReasoner(
  parts: readonly ReasoningPart[],
  hook?: (turn: ReasonerTurn) => void,
): Reasoner {
  return {
    stream(turn) {
      hook?.(turn);
      return (async function*() {
        for (const part of parts) {
          if (turn.signal.aborted) return;
          yield part;
        }
      })();
    },
  };
}

describe("HedgedReasoner", () => {
  it("(a) primary fast — backup never started", async () => {
    const primary = new ControllableReasoner();
    const backup = new ControllableReasoner();
    const scheduler = new FakeScheduler();
    const hedge = new HedgedReasoner({
      primary,
      backup,
      hedgeAfterMs: 50,
      scheduler,
    });

    const streamPromise = collect(hedge, baseTurn());
    primary.emit({ type: "text-delta", text: "hello" });
    primary.emit({ type: "finish", reason: "stop", text: "hello" });

    const parts = await streamPromise;

    expect(backup.streamInvoked).toBe(false);
    expect(scheduler.has("hedge")).toBe(false);
    expect(parts).toEqual([
      { type: "text-delta", text: "hello" },
      { type: "finish", reason: "stop", text: "hello" },
    ]);
  });

  it("(b) hedge fires, primary still wins", async () => {
    const primary = new ControllableReasoner();
    const backup = new ControllableReasoner();
    const scheduler = new FakeScheduler();
    const bus = new PipelineBusImpl();
    const started = bus.start();
    const metrics: ConversationMetricPacket[] = [];
    bus.on("metric.conversation", (pkt) => {
      metrics.push(pkt as ConversationMetricPacket);
    });

    const hedge = new HedgedReasoner({
      primary,
      backup,
      hedgeAfterMs: 50,
      scheduler,
      bus,
      contextId: "ctx-1",
    });

    const streamPromise = collect(hedge, baseTurn());
    await Promise.resolve();
    scheduler.fire("hedge");
    await Promise.resolve();
    expect(backup.streamInvoked).toBe(true);
    expect(metrics).toContainEqual(expect.objectContaining({ name: "hedge.fired", value: "1" }));

    primary.emit({ type: "text-delta", text: "primary" });
    backup.emit({ type: "text-delta", text: "backup" });
    primary.emit({ type: "finish", reason: "stop", text: "primary" });

    const parts = await streamPromise;

    expect(parts).toEqual([
      { type: "text-delta", text: "primary" },
      { type: "finish", reason: "stop", text: "primary" },
    ]);
    expect(metrics).toContainEqual(expect.objectContaining({ name: "hedge.committed_to", value: "primary" }));
    expect(backup.capturedSignal?.aborted).toBe(true);

    bus.stop();
    await started;
  });

  it("(c) backup wins — no interleaving", async () => {
    let primarySignal: AbortSignal | undefined;
    let backupStarted = false;
    const scheduler = new FakeScheduler();
    const hedge = new HedgedReasoner({
      primary: silentReasoner((turn) => {
        primarySignal = turn.signal;
      }),
      backup: scriptedReasoner(
        [
          { type: "text-delta", text: "backup" },
          { type: "finish", reason: "stop", text: "backup" },
        ],
        () => {
          backupStarted = true;
        },
      ),
      hedgeAfterMs: 10,
      scheduler,
    });

    const streamPromise = collect(hedge, baseTurn());
    await Promise.resolve();
    scheduler.fire("hedge");
    const parts = await streamPromise;

    expect(backupStarted).toBe(true);
    expect(parts).toEqual([
      { type: "text-delta", text: "backup" },
      { type: "finish", reason: "stop", text: "backup" },
    ]);
    expect(primarySignal?.aborted).toBe(true);
  });

  it("(d) loser aborted after commit", async () => {
    let primarySignal: AbortSignal | undefined;
    let backupSignal: AbortSignal | undefined;
    const scheduler = new FakeScheduler();
    const hedge = new HedgedReasoner({
      primary: silentReasoner((turn) => {
        primarySignal = turn.signal;
      }),
      backup: scriptedReasoner(
        [
          { type: "text-delta", text: "backup" },
          { type: "finish", reason: "stop", text: "backup" },
        ],
        (turn) => {
          backupSignal = turn.signal;
        },
      ),
      hedgeAfterMs: 5,
      scheduler,
    });

    const streamPromise = collect(hedge, baseTurn());
    await Promise.resolve();
    scheduler.fire("hedge");
    await streamPromise;

    expect(primarySignal?.aborted).toBe(true);
    expect(backupSignal?.aborted).toBe(false);
  });

  it("(e) pre-commit primary error fails over to backup", async () => {
    let backupStarted = false;
    const hedge = new HedgedReasoner({
      primary: scriptedReasoner([
        {
          type: "error",
          cause: new Error("primary down"),
          recoverable: true,
        },
      ]),
      backup: scriptedReasoner(
        [
          { type: "text-delta", text: "recovered" },
          { type: "finish", reason: "stop", text: "recovered" },
        ],
        () => {
          backupStarted = true;
        },
      ),
      hedgeAfterMs: 100,
      scheduler: new FakeScheduler(),
    });

    const parts = await collect(hedge, baseTurn());

    expect(backupStarted).toBe(true);
    expect(parts).toEqual([
      { type: "text-delta", text: "recovered" },
      { type: "finish", reason: "stop", text: "recovered" },
    ]);
    expect(parts.some((p) => p.type === "error")).toBe(false);
  });

  it("(f) post-commit error forwarded verbatim", async () => {
    const primary = new ControllableReasoner();
    const backup = new ControllableReasoner();
    const hedge = new HedgedReasoner({
      primary,
      backup,
      hedgeAfterMs: 100,
      scheduler: new FakeScheduler(),
    });

    const streamPromise = collect(hedge, baseTurn());
    primary.emit({ type: "text-delta", text: "partial" });
    const err: ReasoningPart = {
      type: "error",
      cause: new Error("mid-stream"),
      recoverable: false,
    };
    primary.emit(err);
    backup.emit({ type: "text-delta", text: "backup-late" });

    const parts = await streamPromise;

    expect(parts).toEqual([
      { type: "text-delta", text: "partial" },
      err,
    ]);
    expect(backup.streamInvoked).toBe(false);
  });

  it("(g) metrics — fired iff backup started, committed_to reflects winner; no bus is safe", async () => {
    const scheduler = new FakeScheduler();
    const bus = new PipelineBusImpl();
    const started = bus.start();
    const metrics: ConversationMetricPacket[] = [];
    bus.on("metric.conversation", (pkt) => {
      metrics.push(pkt as ConversationMetricPacket);
    });

    const hedge = new HedgedReasoner({
      primary: silentReasoner(),
      backup: scriptedReasoner([
        { type: "text-delta", text: "b" },
        { type: "finish", reason: "stop", text: "b" },
      ]),
      hedgeAfterMs: 10,
      scheduler,
      bus,
      contextId: "ctx-m",
    });

    const streamPromise = collect(hedge, baseTurn());
    await Promise.resolve();
    scheduler.fire("hedge");
    await streamPromise;

    expect(metrics).toContainEqual(expect.objectContaining({ name: "hedge.fired", value: "1" }));
    expect(metrics).toContainEqual(expect.objectContaining({ name: "hedge.committed_to", value: "backup" }));

    const noBusPrimary = new ControllableReasoner();
    const noBusBackup = new ControllableReasoner();
    const noBusHedge = new HedgedReasoner({
      primary: noBusPrimary,
      backup: noBusBackup,
      hedgeAfterMs: 10,
      scheduler: new FakeScheduler(),
    });

    const noBusPromise = collect(noBusHedge, baseTurn());
    noBusPrimary.emit({ type: "text-delta", text: "ok" });
    noBusPrimary.emit({ type: "finish", reason: "stop", text: "ok" });
    await expect(noBusPromise).resolves.toHaveLength(2);

    bus.stop();
    await started;
  });
});