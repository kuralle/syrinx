// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from "vitest";
import type { IncrementalUnit, IncrementalUnitId } from "./incremental-unit.js";
import { InMemoryIuLedger, type IuLedgerAnomaly } from "./iu-ledger.js";

function makeId(contextId: string, iuId: string, epoch = 1): IncrementalUnitId {
  return { contextId, iuId, epoch };
}

function makeIu(
  contextId: string,
  iuId: string,
  kind: IncrementalUnit["kind"],
  epoch = 1,
): IncrementalUnit {
  return {
    id: makeId(contextId, iuId, epoch),
    kind,
    state: "hypothesized",
  };
}

function seedContexts(ledger: InMemoryIuLedger, count: number): IncrementalUnitId {
  const target = makeId("ctx-target", "iu-target");
  for (let i = 0; i < count; i++) {
    ledger.add(makeIu(`ctx-${i}`, `iu-${i}`, "user_turn", i));
  }
  ledger.add(makeIu(target.contextId, target.iuId, "user_turn", target.epoch));
  return target;
}

/** Count Map.prototype.get calls during a synchronous op — deterministic O(1) probe. */
function countMapGetsDuring<T>(fn: () => T): { result: T; getCount: number } {
  let getCount = 0;
  const originalGet = Map.prototype.get;
  Map.prototype.get = function (this: Map<unknown, unknown>, key: unknown) {
    getCount += 1;
    return originalGet.call(this, key);
  };
  try {
    return { result: fn(), getCount };
  } finally {
    Map.prototype.get = originalGet;
  }
}

describe("InMemoryIuLedger", () => {
  describe("add", () => {
    it("registers a hypothesized IU (happy path)", () => {
      const ledger = new InMemoryIuLedger();
      const iu = makeIu("ctx-a", "iu-1", "user_turn");
      ledger.add(iu);
      expect(ledger.get(iu.id)?.state).toBe("hypothesized");
    });

    it("overwrites an existing iuId with the latest add (failure path: stale hypothesis replaced)", () => {
      const ledger = new InMemoryIuLedger();
      const first = makeIu("ctx-a", "iu-1", "user_turn", 1);
      const second = makeIu("ctx-a", "iu-1", "assistant_response", 2);
      ledger.add(first);
      ledger.add(second);
      expect(ledger.get(first.id)?.kind).toBe("assistant_response");
      expect(ledger.get(first.id)?.id.epoch).toBe(2);
    });
  });

  describe("commit", () => {
    it("transitions hypothesized → committed (happy path)", () => {
      const ledger = new InMemoryIuLedger();
      const iu = makeIu("ctx-a", "iu-1", "assistant_response");
      ledger.add(iu);
      ledger.commit(iu.id);
      expect(ledger.get(iu.id)?.state).toBe("committed");
    });

    it("records committedPrefix when provided (happy path)", () => {
      const ledger = new InMemoryIuLedger();
      const iu = makeIu("ctx-a", "iu-1", "tts_segment");
      ledger.add(iu);
      ledger.commit(iu.id, { ms: 800, chars: 40 });
      expect(ledger.get(iu.id)?.committedPrefix).toEqual({ ms: 800, chars: 40 });
    });

    it("is a no-op on an already-committed IU and fires terminal_op (failure path)", () => {
      const onEvent = vi.fn<(a: IuLedgerAnomaly) => void>();
      const ledger = new InMemoryIuLedger(onEvent);
      const iu = makeIu("ctx-a", "iu-1", "user_turn");
      ledger.add(iu);
      ledger.commit(iu.id);
      ledger.commit(iu.id);
      expect(ledger.get(iu.id)?.state).toBe("committed");
      expect(onEvent).toHaveBeenCalledOnce();
      expect(onEvent).toHaveBeenCalledWith({
        kind: "terminal_op",
        op: "commit",
        id: iu.id,
        state: "committed",
      });
    });

    it("does not un-commit: revoke after commit is a no-op with terminal_op (failure path)", () => {
      const onEvent = vi.fn<(a: IuLedgerAnomaly) => void>();
      const ledger = new InMemoryIuLedger(onEvent);
      const iu = makeIu("ctx-a", "iu-1", "user_turn");
      ledger.add(iu);
      ledger.commit(iu.id);
      ledger.revoke(iu.id);
      expect(ledger.get(iu.id)?.state).toBe("committed");
      expect(onEvent).toHaveBeenCalledOnce();
      expect(onEvent).toHaveBeenCalledWith({
        kind: "terminal_op",
        op: "revoke",
        id: iu.id,
        state: "committed",
      });
    });

    it("fail-open on unknown iuId: no throw, unknown_iu anomaly (failure path)", () => {
      const onEvent = vi.fn<(a: IuLedgerAnomaly) => void>();
      const ledger = new InMemoryIuLedger(onEvent);
      const id = makeId("missing", "iu-1");
      expect(() => ledger.commit(id)).not.toThrow();
      expect(onEvent).toHaveBeenCalledWith({ kind: "unknown_iu", op: "commit", id });
    });
  });

  describe("revoke", () => {
    it("transitions hypothesized → revoked (happy path)", () => {
      const ledger = new InMemoryIuLedger();
      const iu = makeIu("ctx-a", "iu-1", "user_turn");
      ledger.add(iu);
      ledger.revoke(iu.id);
      expect(ledger.get(iu.id)?.state).toBe("revoked");
    });

    it("is a no-op on an already-revoked IU and fires terminal_op (failure path)", () => {
      const onEvent = vi.fn<(a: IuLedgerAnomaly) => void>();
      const ledger = new InMemoryIuLedger(onEvent);
      const iu = makeIu("ctx-a", "iu-1", "user_turn");
      ledger.add(iu);
      ledger.revoke(iu.id);
      ledger.revoke(iu.id);
      expect(ledger.get(iu.id)?.state).toBe("revoked");
      expect(onEvent).toHaveBeenCalledOnce();
      expect(onEvent).toHaveBeenCalledWith({
        kind: "terminal_op",
        op: "revoke",
        id: iu.id,
        state: "revoked",
      });
    });

    it("fail-open on unknown iuId: no throw, unknown_iu anomaly (failure path)", () => {
      const onEvent = vi.fn<(a: IuLedgerAnomaly) => void>();
      const ledger = new InMemoryIuLedger(onEvent);
      const id = makeId("missing", "iu-1");
      expect(() => ledger.revoke(id)).not.toThrow();
      expect(onEvent).toHaveBeenCalledWith({ kind: "unknown_iu", op: "revoke", id });
    });
  });

  describe("get", () => {
    it("returns the registered IU (happy path)", () => {
      const ledger = new InMemoryIuLedger();
      const iu = makeIu("ctx-a", "iu-1", "user_turn");
      ledger.add(iu);
      expect(ledger.get(iu.id)).toBe(iu);
    });

    it("returns undefined for an unknown id without throwing (failure path)", () => {
      const ledger = new InMemoryIuLedger();
      expect(ledger.get(makeId("missing", "iu-1"))).toBeUndefined();
    });
  });

  describe("latest", () => {
    it("returns the most recently added IU of the requested kind (happy path)", () => {
      const ledger = new InMemoryIuLedger();
      ledger.add(makeIu("ctx-a", "iu-1", "user_turn"));
      ledger.add(makeIu("ctx-a", "iu-2", "assistant_response"));
      ledger.add(makeIu("ctx-a", "iu-3", "user_turn"));
      const latest = ledger.latest("ctx-a", "user_turn");
      expect(latest?.id.iuId).toBe("iu-3");
    });

    it("returns undefined when no IU of that kind exists (failure path)", () => {
      const ledger = new InMemoryIuLedger();
      ledger.add(makeIu("ctx-a", "iu-1", "user_turn"));
      expect(ledger.latest("ctx-a", "tts_segment")).toBeUndefined();
      expect(ledger.latest("missing", "user_turn")).toBeUndefined();
    });
  });

  describe("clear", () => {
    it("removes only the requested context (happy path)", () => {
      const ledger = new InMemoryIuLedger();
      const a = makeIu("ctx-a", "iu-1", "user_turn");
      const b = makeIu("ctx-b", "iu-1", "user_turn");
      ledger.add(a);
      ledger.add(b);
      ledger.clear("ctx-a");
      expect(ledger.get(a.id)).toBeUndefined();
      expect(ledger.get(b.id)?.state).toBe("hypothesized");
    });

    it("is a no-op for an unknown context without affecting others (failure path)", () => {
      const ledger = new InMemoryIuLedger();
      const b = makeIu("ctx-b", "iu-1", "user_turn");
      ledger.add(b);
      ledger.clear("ctx-missing");
      expect(ledger.get(b.id)?.state).toBe("hypothesized");
    });
  });

  describe("monotonic state machine", () => {
    it("follows hypothesized → committed and hypothesized → revoked only", () => {
      const ledger = new InMemoryIuLedger();
      const committed = makeIu("ctx-a", "iu-commit", "user_turn");
      const revoked = makeIu("ctx-a", "iu-revoke", "user_turn");
      ledger.add(committed);
      ledger.add(revoked);
      ledger.commit(committed.id);
      ledger.revoke(revoked.id);
      expect(ledger.get(committed.id)?.state).toBe("committed");
      expect(ledger.get(revoked.id)?.state).toBe("revoked");
    });
  });

  describe("maxContexts bound", () => {
    it("evicts the oldest context when a new context exceeds the cap (FIFO)", () => {
      const ledger = new InMemoryIuLedger(() => {}, 3);
      const a = makeIu("a", "iu-1", "user_turn");
      const b = makeIu("b", "iu-1", "user_turn");
      const c = makeIu("c", "iu-1", "user_turn");
      const d = makeIu("d", "iu-1", "user_turn");
      ledger.add(a);
      ledger.add(b);
      ledger.add(c);
      ledger.add(d);
      expect(ledger.get(a.id)).toBeUndefined();
      expect(ledger.get(b.id)?.state).toBe("hypothesized");
      expect(ledger.get(c.id)?.state).toBe("hypothesized");
      expect(ledger.get(d.id)?.state).toBe("hypothesized");
    });

    it("does not evict when adding another IU to an existing context", () => {
      const ledger = new InMemoryIuLedger(() => {}, 3);
      const a1 = makeIu("a", "iu-1", "user_turn");
      const a2 = makeIu("a", "iu-2", "assistant_response");
      const b = makeIu("b", "iu-1", "user_turn");
      const c = makeIu("c", "iu-1", "user_turn");
      ledger.add(a1);
      ledger.add(b);
      ledger.add(c);
      ledger.add(a2);
      expect(ledger.get(a1.id)?.state).toBe("hypothesized");
      expect(ledger.get(a2.id)?.state).toBe("hypothesized");
      expect(ledger.get(b.id)?.state).toBe("hypothesized");
      expect(ledger.get(c.id)?.state).toBe("hypothesized");
    });
  });

  describe("O(1) per-op (structural)", () => {
    it("commit/get touch only the target ctx bucket regardless of total ctx count", () => {
      // Map.get is O(1); each hot-path op does one outer + one inner lookup — independent of ctx count.
      const ledgerSmall = new InMemoryIuLedger();
      const ledgerLarge = new InMemoryIuLedger();
      const targetSmall = seedContexts(ledgerSmall, 10);
      const targetLarge = seedContexts(ledgerLarge, 1000);

      const commitGetsSmall = countMapGetsDuring(() => ledgerSmall.commit(targetSmall)).getCount;
      const commitGetsLarge = countMapGetsDuring(() => ledgerLarge.commit(targetLarge)).getCount;
      expect(commitGetsLarge).toBe(commitGetsSmall);

      expect(ledgerSmall.get(targetSmall)?.state).toBe("committed");
      expect(ledgerLarge.get(targetLarge)?.state).toBe("committed");

      const getGetsSmall = countMapGetsDuring(() => ledgerSmall.get(targetSmall)).getCount;
      const getGetsLarge = countMapGetsDuring(() => ledgerLarge.get(targetLarge)).getCount;
      expect(getGetsLarge).toBe(getGetsSmall);
    });
  });
});
