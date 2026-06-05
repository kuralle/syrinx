// SPDX-License-Identifier: MIT

import type { ScheduledCallback, Scheduler } from "@asyncdot/voice";

type SqlCursor<T> = Iterable<T>;

interface SqlStorage {
  exec(query: string, ...bindings: unknown[]): SqlCursor<Record<string, unknown>>;
}

export interface DurableSchedulerStorage {
  readonly sql: SqlStorage;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export class DurableObjectAlarmScheduler implements Scheduler {
  private readonly callbacks = new Map<string, ScheduledCallback>();

  constructor(private readonly storage: DurableSchedulerStorage) {
    this.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS scheduled_tasks (key TEXT PRIMARY KEY, deadline_ms INTEGER NOT NULL)",
    );
  }

  schedule(key: string, delayMs: number, cb: ScheduledCallback): void {
    const deadlineMs = Date.now() + Math.max(0, delayMs);
    this.callbacks.set(key, cb);
    this.storage.sql.exec(
      "INSERT OR REPLACE INTO scheduled_tasks (key, deadline_ms) VALUES (?, ?)",
      key,
      deadlineMs,
    );
    void this.armNext();
  }

  cancel(key: string): void {
    this.callbacks.delete(key);
    this.storage.sql.exec("DELETE FROM scheduled_tasks WHERE key = ?", key);
    void this.armNext();
  }

  async runDue(nowMs = Date.now()): Promise<void> {
    const due = [...this.storage.sql.exec(
      "SELECT key FROM scheduled_tasks WHERE deadline_ms <= ? ORDER BY deadline_ms ASC",
      nowMs,
    )] as Array<{ key: string }>;
    for (const row of due) {
      this.storage.sql.exec("DELETE FROM scheduled_tasks WHERE key = ?", row.key);
      const cb = this.callbacks.get(row.key);
      this.callbacks.delete(row.key);
      if (cb) await cb();
    }
    await this.armNext();
  }

  private async armNext(): Promise<void> {
    const [next] = [...this.storage.sql.exec(
      "SELECT deadline_ms FROM scheduled_tasks ORDER BY deadline_ms ASC LIMIT 1",
    )] as Array<{ deadline_ms: number }>;
    if (!next) {
      await this.storage.deleteAlarm();
      return;
    }
    await this.storage.setAlarm(next.deadline_ms);
  }
}
