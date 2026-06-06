// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import type { ManagedSession } from "@kuralle-syrinx/server-websocket/session-store";
import { DurableObjectAlarmScheduler } from "./alarm-scheduler.js";
import { DurableObjectSessionStore } from "./durable-session-store.js";
import { MemoryDurableStorage } from "./test-storage.js";

describe("DurableObjectSessionStore", () => {
  it("persists turn metadata and restores it when the live session is recreated", async () => {
    const storage = new MemoryDurableStorage();
    const scheduler = new DurableObjectAlarmScheduler(storage);
    const store = new DurableObjectSessionStore(storage, scheduler);

    const first = await store.lease("s1", async () => managed("s1", "turn-a"));
    store.update("s1", (stored) => {
      stored.currentContextId = "turn-b";
      stored.inputSequence.lastSequence = 7;
    });
    first.managed.connectionCount = 0;
    await store.release("s1", 1000);

    const recreatedStore = new DurableObjectSessionStore(storage, scheduler);
    const second = await recreatedStore.lease("s1", async () => managed("s1", "fresh"));

    expect(second.resumed).toBe(true);
    expect(second.managed.currentContextId).toBe("turn-b");
    expect(second.managed.inputSequence.lastSequence).toBe(7);
  });

  it("deletes retained sessions when the scheduled release fires", async () => {
    const storage = new MemoryDurableStorage();
    const scheduler = new DurableObjectAlarmScheduler(storage);
    const store = new DurableObjectSessionStore(storage, scheduler);
    const leased = await store.lease("s2", async () => managed("s2", "turn-a"));
    leased.managed.connectionCount = 0;

    await store.release("s2", 5);
    await scheduler.runDue(Date.now() + 10);

    expect(await store.get("s2")).toBeNull();
    expect(storage.sessions.has("s2")).toBe(false);
  });
});

function managed(id: string, currentContextId: string): ManagedSession {
  return {
    id,
    session: {
      start: async () => undefined,
      close: async () => undefined,
    } as ManagedSession["session"],
    currentContextId,
    contextSampleRates: new Map(),
    inputSequence: { lastSequence: null },
    turnMetricsTurns: new Map(),
    closeTimer: null,
    connectionCount: 0,
  };
}
