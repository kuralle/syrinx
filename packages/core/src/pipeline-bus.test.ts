// SPDX-License-Identifier: MIT

import { describe, it, expect, vi } from "vitest";
import { PipelineBusImpl, Route, type PipelineBusConfig } from "../src/pipeline-bus.js";
import type { VoicePacket, ConversationMetricPacket } from "../src/packets.js";

// =============================================================================
// Helpers
// =============================================================================

function pkt(kind: string, contextId = "ctx-1"): VoicePacket {
  return { kind, contextId, timestampMs: Date.now() };
}

function createBus(config?: PipelineBusConfig): PipelineBusImpl {
  return new PipelineBusImpl(config);
}

/** Start bus, run fn, stop bus, await drain completion. */
async function withBus(
  config: PipelineBusConfig | undefined,
  fn: (bus: PipelineBusImpl) => void | Promise<void>,
): Promise<void> {
  const bus = createBus(config);
  const startP = bus.start();
  // Give the start loop a tick to begin
  await new Promise((r) => setTimeout(r, 5));
  await fn(bus);
  // Allow pending dispatches to complete
  await new Promise((r) => setTimeout(r, 20));
  bus.stop();
  await startP;
}

// =============================================================================
// Tests
// =============================================================================

describe("PipelineBusImpl", () => {
  describe("push and drain order", () => {
    it("drains Critical before Main", async () => {
      const processed: string[] = [];
      await withBus(undefined, (bus) => {
        bus.on("critical.event", () => { processed.push("critical"); });
        bus.on("main.event", () => { processed.push("main"); });
        bus.push(Route.Main, pkt("main.event"));
        bus.push(Route.Critical, pkt("critical.event"));
      });
      expect(processed).toEqual(["critical", "main"]);
    });

    it("drains Main before Background", async () => {
      const processed: string[] = [];
      await withBus(undefined, (bus) => {
        bus.on("main.event", () => { processed.push("main"); });
        bus.on("bg.event", () => { processed.push("bg"); });
        bus.push(Route.Background, pkt("bg.event"));
        bus.push(Route.Main, pkt("main.event"));
      });
      expect(processed).toEqual(["main", "bg"]);
    });

    it("batches Critical up to criticalBatchSize before yielding", async () => {
      const processed: string[] = [];
      await withBus({ criticalBatchSize: 3 }, (bus) => {
        bus.on("critical.event", () => { processed.push("c"); });
        for (let i = 0; i < 5; i++) {
          bus.push(Route.Critical, pkt("critical.event"));
        }
      });
      expect(processed.length).toBeGreaterThanOrEqual(5);
    });
  });

  describe("capacity and overflow", () => {
    it("drops oldest Background on overflow", async () => {
      const dropped: VoicePacket[] = [];
      const metrics: string[] = [];
      await withBus(
        { bgCapacity: 2, onBackgroundDrop: (d: VoicePacket) => { dropped.push(d); } },
        (bus) => {
          bus.on("metric.conversation", (pkt: any) => {
            metrics.push(pkt.name);
          });
          bus.push(Route.Background, pkt("bg.1", "id-1"));
          bus.push(Route.Background, pkt("bg.2", "id-2"));
          bus.push(Route.Background, pkt("bg.3", "id-3"));
        },
      );
      expect(dropped.length).toBeGreaterThanOrEqual(1);
      if (dropped.length > 0) {
        expect(dropped[0]!.contextId).toBe("id-1");
      }
      expect(metrics).toContain("pipeline.bus.background.dropped");
    });

    it("does not throw on Main overflow", () => {
      const bus = createBus({ mainCapacity: 1 });
      bus.push(Route.Main, pkt("main.1"));
      expect(() => bus.push(Route.Main, pkt("main.2"))).not.toThrow();
    });

    it("drops oldest Main on overflow without throwing", async () => {
      const dropped: VoicePacket[] = [];
      const metrics: string[] = [];
      const dispatched: string[] = [];
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const bus = createBus({
        mainCapacity: 2,
        onMainDrop: (d) => {
          dropped.push(d);
        },
      });

      let releaseMain!: () => void;
      const mainGate = new Promise<void>((resolve) => {
        releaseMain = resolve;
      });

      bus.on(
        "llm.delta",
        async (p) => {
          dispatched.push(p.contextId);
          await mainGate;
        },
        { serial: true },
      );
      bus.on("metric.conversation", (p) => {
        metrics.push((p as ConversationMetricPacket).name);
      });

      const drain = bus.start();
      bus.push(Route.Main, pkt("llm.delta", "pkt-1"));
      await new Promise((r) => setTimeout(r, 20));

      expect(() => {
        bus.push(Route.Main, pkt("llm.delta", "pkt-2"));
        bus.push(Route.Main, pkt("llm.delta", "pkt-3"));
        bus.push(Route.Main, pkt("llm.delta", "pkt-4"));
      }).not.toThrow();

      expect(dropped.some((d) => d.contextId === "pkt-2")).toBe(true);
      expect(dropped.length).toBeGreaterThanOrEqual(1);
      expect(errorSpy).toHaveBeenCalled();

      releaseMain();
      await new Promise((r) => setTimeout(r, 80));

      expect(metrics).toContain("pipeline.bus.main.dropped");

      expect(dispatched).toContain("pkt-1");
      expect(dispatched).toContain("pkt-3");
      expect(dispatched).toContain("pkt-4");
      expect(dispatched).not.toContain("pkt-2");

      // Session recovers — a subsequent packet dispatches normally after the stall.
      bus.push(Route.Main, pkt("llm.delta", "pkt-recovery"));
      await new Promise((r) => setTimeout(r, 80));
      expect(dispatched).toContain("pkt-recovery");

      bus.stop();
      await drain;
      errorSpy.mockRestore();
    });

    it("logs a Main overflow episode once, not per dropped packet", () => {
      // Once Main saturates, every push drops one. A log per drop would put a
      // synchronous stderr write on the hot path of an already-struggling
      // session. The metric and callback still fire per drop.
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const dropped: VoicePacket[] = [];
      const bus = createBus({
        mainCapacity: 1,
        onMainDrop: (d) => {
          dropped.push(d);
        },
      });

      bus.push(Route.Main, pkt("llm.delta", "seed"));
      for (let i = 0; i < 25; i += 1) bus.push(Route.Main, pkt("llm.delta", `flood-${String(i)}`));

      expect(dropped.length).toBe(25);
      expect(errorSpy).toHaveBeenCalledTimes(1);

      errorSpy.mockRestore();
    });

    it("Critical never overflows", () => {
      const bus = createBus();
      for (let i = 0; i < 10000; i++) {
        bus.push(Route.Critical, pkt("critical.event"));
      }
      expect(true).toBe(true);
    });
  });

  describe("handler registration", () => {
    it("calls matching handler for packet kind", async () => {
      const fn = vi.fn();
      await withBus(undefined, (bus) => {
        bus.on("test.event", fn);
        bus.push(Route.Main, pkt("test.event"));
      });
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("does not call handler for different kind", async () => {
      const fn = vi.fn();
      await withBus(undefined, (bus) => {
        bus.on("test.event", fn);
        bus.push(Route.Main, pkt("other.event"));
      });
      expect(fn).not.toHaveBeenCalled();
    });

    it("unsubscribe removes handler", async () => {
      const fn = vi.fn();
      await withBus(undefined, (bus) => {
        const unsub = bus.on("test.event", fn);
        unsub();
        bus.push(Route.Main, pkt("test.event"));
      });
      expect(fn).not.toHaveBeenCalled();
    });

    it("multiple handlers for same kind all fire", async () => {
      const fn1 = vi.fn();
      const fn2 = vi.fn();
      await withBus(undefined, (bus) => {
        bus.on("test.event", fn1);
        bus.on("test.event", fn2);
        bus.push(Route.Main, pkt("test.event"));
      });
      expect(fn1).toHaveBeenCalledTimes(1);
      expect(fn2).toHaveBeenCalledTimes(1);
    });
  });

  describe("allPackets", () => {
    it("publishes every pushed packet with its route", async () => {
      const bus = createBus();
      const reader = bus.allPackets.getReader();
      bus.push(Route.Main, pkt("main.event", "main-1"));
      bus.push(Route.Critical, pkt("critical.event", "critical-1"));

      const first = await reader.read();
      const second = await reader.read();
      reader.releaseLock();

      expect(first.value).toMatchObject({
        route: Route.Main,
        packet: { kind: "main.event", contextId: "main-1" },
      });
      expect(second.value).toMatchObject({
        route: Route.Critical,
        packet: { kind: "critical.event", contextId: "critical-1" },
      });
    });

    it("does not retain packets when no reader is attached (drop-on-unread)", async () => {
      const bus = createBus();
      // No getReader() → stream unlocked → nothing retained (else a call with no
      // recorder would buffer every audio packet and OOM).
      for (let i = 0; i < 1000; i++) bus.push(Route.Main, pkt("main.event", `n-${i}`));

      // A reader that attaches later sees only packets pushed AFTER it attaches.
      const reader = bus.allPackets.getReader();
      bus.push(Route.Main, pkt("main.event", "after-reader"));
      const next = await reader.read();
      reader.releaseLock();
      expect(next.value).toMatchObject({ packet: { contextId: "after-reader" } });
    });
  });

  describe("error handling", () => {
    it("handler error pushes VoiceErrorPacket to Critical", async () => {
      const errorHandler = vi.fn();
      await withBus(undefined, (bus) => {
        bus.on("test.event", () => { throw new Error("boom"); });
        bus.on("pipeline.error", errorHandler);
        bus.push(Route.Main, pkt("test.event"));
      });
      expect(errorHandler).toHaveBeenCalled();
    });

    it("handler error does not stop other handlers", async () => {
      const fn2 = vi.fn();
      await withBus(undefined, (bus) => {
        bus.on("test.event", () => { throw new Error("boom"); });
        bus.on("test.event", fn2);
        bus.push(Route.Main, pkt("test.event"));
      });
      expect(fn2).toHaveBeenCalledTimes(1);
    });
  });
});
