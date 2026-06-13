// SPDX-License-Identifier: MIT
//
// RunStore for the mastra HITL suspend/resume flow, backed by the Durable Object's
// SQLite (the storage Mastra's own CloudflareDOStorage uses). Stale run pointers
// expire lazily on read — no scheduled-alarm cleanup needed, so the DO does not
// re-implement a task scheduler.

import type { RunPointer, RunStore } from "@kuralle-syrinx/aisdk";

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
  }

  takePending(contextId: string): RunPointer | null {
    const [row] = [...this.storage.sql.exec(
      "SELECT run_id, created_at_ms FROM reasoning_run_pointers WHERE context_id = ?",
      contextId,
    )] as Array<{ run_id: string; created_at_ms: number }>;
    if (!row) return null;
    // Lazy TTL: a pointer past its window is treated as absent and swept on read.
    if (Date.now() - Number(row.created_at_ms) > this.ttlMs) {
      this.discard(contextId);
      return null;
    }
    return { runId: row.run_id };
  }

  discard(contextId: string): void {
    this.storage.sql.exec("DELETE FROM reasoning_run_pointers WHERE context_id = ?", contextId);
  }
}
