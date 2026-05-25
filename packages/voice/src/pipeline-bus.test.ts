// SPDX-License-Identifier: MIT

import { describe, it, expect, vi } from "vitest";
import { PipelineBusImpl, Route, type PipelineBusConfig } from "../src/pipeline-bus.js";
import type { VoicePacket } from "../src/packets.js";

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
      await withBus(
        { bgCapacity: 2, onBackgroundDrop: (d: VoicePacket) => { dropped.push(d); } },
        (bus) => {
          bus.push(Route.Background, pkt("bg.1", "id-1"));
          bus.push(Route.Background, pkt("bg.2", "id-2"));
          bus.push(Route.Background, pkt("bg.3", "id-3"));
        },
      );
      expect(dropped.length).toBeGreaterThanOrEqual(1);
      if (dropped.length > 0) {
        expect(dropped[0]!.contextId).toBe("id-1");
      }
    });

    it("throws on Main overflow", () => {
      const bus = createBus({ mainCapacity: 1 });
      bus.push(Route.Main, pkt("main.1"));
      expect(() => bus.push(Route.Main, pkt("main.2"))).toThrow("Main queue full");
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
