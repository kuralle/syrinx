// SPDX-License-Identifier: MIT

interface SessionRow {
  id: string;
  current_context_id: string;
  last_sequence: number | null;
  retained_until_ms: number;
  connection_count: number;
  updated_at_ms: number;
}

interface TaskRow {
  key: string;
  deadline_ms: number;
}

export class MemoryDurableStorage {
  readonly sessions = new Map<string, SessionRow>();
  readonly tasks = new Map<string, TaskRow>();
  alarm: number | null = null;

  readonly sql = {
    exec: (query: string, ...bindings: unknown[]): Iterable<Record<string, unknown>> => {
      const normalized = query.replace(/\s+/g, " ").trim();
      if (normalized.startsWith("CREATE TABLE")) return [];
      if (normalized.startsWith("INSERT OR REPLACE INTO scheduled_tasks")) {
        const key = String(bindings[0]);
        this.tasks.set(key, { key, deadline_ms: Number(bindings[1]) });
        return [];
      }
      if (normalized.startsWith("DELETE FROM scheduled_tasks WHERE key")) {
        this.tasks.delete(String(bindings[0]));
        return [];
      }
      if (normalized.startsWith("SELECT key FROM scheduled_tasks")) {
        const now = Number(bindings[0]);
        return [...this.tasks.values()]
          .filter((row) => row.deadline_ms <= now)
          .sort((a, b) => a.deadline_ms - b.deadline_ms) as unknown as Record<string, unknown>[];
      }
      if (normalized.startsWith("SELECT deadline_ms FROM scheduled_tasks")) {
        const next = [...this.tasks.values()].sort((a, b) => a.deadline_ms - b.deadline_ms)[0];
        return (next ? [{ deadline_ms: next.deadline_ms }] : []) as Record<string, unknown>[];
      }
      if (normalized.startsWith("INSERT OR REPLACE INTO sessions")) {
        const row: SessionRow = {
          id: String(bindings[0]),
          current_context_id: String(bindings[1]),
          last_sequence: bindings[2] === null ? null : Number(bindings[2]),
          retained_until_ms: Number(bindings[3]),
          connection_count: Number(bindings[4]),
          updated_at_ms: Number(bindings[5]),
        };
        this.sessions.set(row.id, row);
        return [];
      }
      if (normalized.startsWith("DELETE FROM sessions WHERE id")) {
        this.sessions.delete(String(bindings[0]));
        return [];
      }
      if (normalized.startsWith("DELETE FROM sessions")) {
        this.sessions.clear();
        return [];
      }
      if (normalized.startsWith("SELECT * FROM sessions WHERE id")) {
        const row = this.sessions.get(String(bindings[0]));
        return (row ? [row] : []) as unknown as Record<string, unknown>[];
      }
      throw new Error(`Unsupported test SQL: ${normalized}`);
    },
  };

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarm = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
}
