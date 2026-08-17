// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { PipelineBusImpl } from "./pipeline-bus.js";
import type { ConversationMetricPacket } from "./packets.js";
import type { Reasoner, ReasonerTurn, ReasoningPart } from "./reasoner.js";
import { RoutingReasoner } from "./reasoner-route.js";

class ControllableReasoner implements Reasoner {
  streamInvoked = false;
  streamCallCount = 0;
  capturedSignal: AbortSignal | undefined;
  private deliver: ((part: ReasoningPart) => void) | null = null;

  stream(turn: ReasonerTurn): AsyncIterable<ReasoningPart> {
    this.streamInvoked = true;
    this.streamCallCount += 1;
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

const fastParts: ReasoningPart[] = [
  { type: "text-delta", text: "fast" },
  { type: "finish", reason: "stop", text: "fast" },
];

const deepParts: ReasoningPart[] = [
  { type: "text-delta", text: "deep" },
  { type: "finish", reason: "stop", text: "deep" },
];

describe("RoutingReasoner", () => {
  it("classify routing — fast and deep without speculation", async () => {
    let fastInvoked = false;
    let deepInvoked = false;

    const routes = [
      {
        id: "fast",
        reasoner: scriptedReasoner(fastParts, () => {
          fastInvoked = true;
        }),
      },
      {
        id: "deep",
        reasoner: scriptedReasoner(deepParts, () => {
          deepInvoked = true;
        }),
      },
    ];

    const fastRouter = new RoutingReasoner({
      routes,
      classify: () => "fast",
    });
    const fastOutput = await collect(fastRouter, baseTurn());
    expect(fastOutput).toEqual(fastParts);
    expect(fastInvoked).toBe(true);
    expect(deepInvoked).toBe(false);

    fastInvoked = false;
    deepInvoked = false;

    const deepRouter = new RoutingReasoner({
      routes,
      classify: () => "deep",
    });
    const deepOutput = await collect(deepRouter, baseTurn());
    expect(deepOutput).toEqual(deepParts);
    expect(deepInvoked).toBe(true);
    expect(fastInvoked).toBe(false);
  });

  it("speculation kept (agree)", async () => {
    const fast = new ControllableReasoner();
    const deep = new ControllableReasoner();
    const bus = new PipelineBusImpl();
    const started = bus.start();
    const metrics: ConversationMetricPacket[] = [];
    bus.on("metric.conversation", (pkt) => {
      metrics.push(pkt as ConversationMetricPacket);
    });

    const router = new RoutingReasoner({
      routes: [
        { id: "fast", reasoner: fast },
        { id: "deep", reasoner: deep },
      ],
      classify: () => "fast",
      speculateRouteId: "fast",
      bus,
      contextId: "ctx-1",
    });

    const streamPromise = collect(router, baseTurn());
    fast.emit({ type: "text-delta", text: "fast" });
    fast.emit({ type: "finish", reason: "stop", text: "fast" });
    const parts = await streamPromise;

    expect(fast.streamCallCount).toBe(1);
    expect(deep.streamInvoked).toBe(false);
    expect(parts).toEqual(fastParts);
    expect(metrics).toContainEqual(expect.objectContaining({ name: "route.selected", value: "fast" }));
    expect(metrics.some((m) => m.name === "route.mispredict")).toBe(false);

    bus.stop();
    await started;
  });

  it("speculation discarded (disagree) — no forwarded part from mispredicted route", async () => {
    const fast = new ControllableReasoner();
    let deepInvoked = false;
    let resolveClassify: ((id: string) => void) | undefined;
    const classifyGate = new Promise<string>((resolve) => {
      resolveClassify = resolve;
    });

    const bus = new PipelineBusImpl();
    const started = bus.start();
    const metrics: ConversationMetricPacket[] = [];
    bus.on("metric.conversation", (pkt) => {
      metrics.push(pkt as ConversationMetricPacket);
    });

    const router = new RoutingReasoner({
      routes: [
        { id: "fast", reasoner: fast },
        {
          id: "deep",
          reasoner: scriptedReasoner(deepParts, () => {
            deepInvoked = true;
          }),
        },
      ],
      classify: () => classifyGate,
      speculateRouteId: "fast",
      bus,
      contextId: "ctx-2",
    });

    const streamPromise = collect(router, baseTurn());
    await Promise.resolve();
    fast.emit({ type: "text-delta", text: "must-not-forward" });
    resolveClassify!("deep");
    const parts = await streamPromise;

    expect(fast.capturedSignal?.aborted).toBe(true);
    expect(fast.streamCallCount).toBe(1);
    expect(deepInvoked).toBe(true);
    expect(parts).toEqual(deepParts);
    expect(metrics).toContainEqual(expect.objectContaining({ name: "route.mispredict", value: "1" }));
    expect(metrics).toContainEqual(expect.objectContaining({ name: "route.selected", value: "deep" }));

    bus.stop();
    await started;
  });

  it("R8 passthrough — single route equals direct stream", async () => {
    const soleParts: ReasoningPart[] = [
      { type: "text-delta", text: "only" },
      { type: "finish", reason: "stop", text: "only" },
    ];
    const sole = scriptedReasoner(soleParts);
    const direct = await collect(sole, baseTurn());

    const router = new RoutingReasoner({
      routes: [{ id: "only", reasoner: sole }],
      classify: () => "only",
    });
    const routed = await collect(router, baseTurn());

    expect(routed).toEqual(direct);
    expect(routed).toEqual(soleParts);
  });

  it("unknown id — throws clear error", async () => {
    const router = new RoutingReasoner({
      routes: [{ id: "fast", reasoner: scriptedReasoner(fastParts) }],
      classify: () => "missing",
    });

    await expect(collect(router, baseTurn())).rejects.toThrow('RoutingReasoner: unknown route id "missing"');
  });

  it("forwards client-message from a kept speculative route, ordered against text-delta", async () => {
    const fast = new ControllableReasoner();
    const deep = new ControllableReasoner();
    const bus = new PipelineBusImpl();
    const started = bus.start();

    const router = new RoutingReasoner({
      routes: [
        { id: "fast", reasoner: fast },
        { id: "deep", reasoner: deep },
      ],
      classify: () => "fast",
      speculateRouteId: "fast",
      bus,
      contextId: "ctx-cm-1",
    });

    const streamPromise = collect(router, baseTurn());
    fast.emit({ type: "text-delta", text: "here is " });
    fast.emit({ type: "client-message", payload: { card: "invoice" } });
    fast.emit({ type: "text-delta", text: "your invoice" });
    fast.emit({ type: "finish", reason: "stop", text: "here is your invoice" });
    const parts = await streamPromise;

    expect(deep.streamInvoked).toBe(false);
    expect(parts).toEqual([
      { type: "text-delta", text: "here is " },
      { type: "client-message", payload: { card: "invoice" } },
      { type: "text-delta", text: "your invoice" },
      { type: "finish", reason: "stop", text: "here is your invoice" },
    ]);

    bus.stop();
    await started;
  });

  it("drops a client-message from a mispredicted speculative route", async () => {
    const fast = new ControllableReasoner();
    let deepInvoked = false;
    let resolveClassify: ((id: string) => void) | undefined;
    const classifyGate = new Promise<string>((resolve) => {
      resolveClassify = resolve;
    });

    const bus = new PipelineBusImpl();
    const started = bus.start();

    const deepPartsWithClientMessage: ReasoningPart[] = [
      { type: "client-message", payload: { card: "deep-route" } },
      { type: "text-delta", text: "deep" },
      { type: "finish", reason: "stop", text: "deep" },
    ];

    const router = new RoutingReasoner({
      routes: [
        { id: "fast", reasoner: fast },
        {
          id: "deep",
          reasoner: scriptedReasoner(deepPartsWithClientMessage, () => {
            deepInvoked = true;
          }),
        },
      ],
      classify: () => classifyGate,
      speculateRouteId: "fast",
      bus,
      contextId: "ctx-cm-2",
    });

    const streamPromise = collect(router, baseTurn());
    await Promise.resolve();
    // The speculative route emits its own client-message before the mispredict —
    // it must never reach the output once "deep" is chosen instead.
    fast.emit({ type: "client-message", payload: { card: "must-not-forward" } });
    resolveClassify!("deep");
    const parts = await streamPromise;

    expect(fast.capturedSignal?.aborted).toBe(true);
    expect(deepInvoked).toBe(true);
    expect(parts).toEqual(deepPartsWithClientMessage);

    bus.stop();
    await started;
  });
});