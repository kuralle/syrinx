// SPDX-License-Identifier: MIT

import type { RunPointer, RunStore } from "@asyncdot/voice-bridge-aisdk";
import type { DurableObjectAlarmScheduler } from "./alarm-scheduler.js";

type SqlCursor<T> = Iterable<T>;

interface SqlStorage {
  exec(query: string, ...bindings: unknown[]): SqlCursor<Record<string, unknown>>;
}

export interface DurableRunStorage {
  readonly sql: SqlStorage;
}

export const DEFAULT_RUN_POINTER_TTL_MS = 15 * 60 * 1000;

export class DurableObjectRunStore implements RunStore {
  constructor(
    private readonly storage: DurableRunStorage,
    private readonly scheduler: DurableObjectAlarmScheduler,
    private readonly ttlMs = DEFAULT_RUN_POINTER_TTL_MS,
  ) {
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS reasoning_run_pointers (
        context_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      )`,
    );
  }

  save(contextId: string, runId: string): void {
    this.storage.sql.exec(
      "INSERT OR REPLACE INTO reasoning_run_pointers (context_id, run_id, created_at_ms) VALUES (?, ?, ?)",
      contextId,
      runId,
      Date.now(),
    );
    this.scheduler.schedule(`run.ttl:${contextId}`, this.ttlMs, () => {
      this.discard(contextId);
    });
  }

  takePending(contextId: string): RunPointer | null {
    const [row] = [...this.storage.sql.exec(
      "SELECT run_id FROM reasoning_run_pointers WHERE context_id = ?",
      contextId,
    )] as Array<{ run_id: string }>;
    return row ? { runId: row.run_id } : null;
  }

  discard(contextId: string): void {
    this.scheduler.cancel(`run.ttl:${contextId}`);
    this.storage.sql.exec("DELETE FROM reasoning_run_pointers WHERE context_id = ?", contextId);
  }
}
