// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { DurableObjectAlarmScheduler } from "./alarm-scheduler.js";
import { MemoryDurableStorage } from "./test-storage.js";

describe("DurableObjectAlarmScheduler", () => {
  it("persists deadlines, fires due callbacks, and rearms the nearest remaining task", async () => {
    const storage = new MemoryDurableStorage();
    const scheduler = new DurableObjectAlarmScheduler(storage);
    const fired: string[] = [];

    scheduler.schedule("late", 1000, () => {
      fired.push("late");
    });
    scheduler.schedule("soon", 50, () => {
      fired.push("soon");
    });

    expect(storage.tasks.has("soon")).toBe(true);
    expect(storage.alarm).toBeLessThanOrEqual(Date.now() + 1000);

    await scheduler.runDue(Date.now() + 100);

    expect(fired).toEqual(["soon"]);
    expect(storage.tasks.has("soon")).toBe(false);
    expect(storage.tasks.has("late")).toBe(true);
  });

  it("cancels persisted tasks before the alarm fires", async () => {
    const storage = new MemoryDurableStorage();
    const scheduler = new DurableObjectAlarmScheduler(storage);
    let fired = false;

    scheduler.schedule("task", 1, () => {
      fired = true;
    });
    scheduler.cancel("task");
    await scheduler.runDue(Date.now() + 10);

    expect(fired).toBe(false);
    expect(storage.tasks.size).toBe(0);
  });
});
