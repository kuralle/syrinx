// SPDX-License-Identifier: MIT

import type {
  ManagedSession,
  ManagedSessionLease,
  SessionStore,
} from "@asyncdot/voice-server-websocket/session-store";
import type { DurableObjectAlarmScheduler } from "./alarm-scheduler.js";

type SqlCursor<T> = Iterable<T>;

interface SqlStorage {
  exec(query: string, ...bindings: unknown[]): SqlCursor<Record<string, unknown>>;
}

export interface DurableSessionStorage {
  readonly sql: SqlStorage;
}

interface SessionRow {
  id: string;
  current_context_id: string;
  last_sequence: number | null;
  retained_until_ms: number;
  connection_count: number;
}

export class DurableObjectSessionStore implements SessionStore {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly pendingLeases = new Map<string, Promise<ManagedSession>>();

  constructor(
    private readonly storage: DurableSessionStorage,
    private readonly scheduler: DurableObjectAlarmScheduler,
  ) {
    this.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        current_context_id TEXT NOT NULL,
        last_sequence INTEGER,
        retained_until_ms INTEGER NOT NULL DEFAULT 0,
        connection_count INTEGER NOT NULL DEFAULT 0,
        updated_at_ms INTEGER NOT NULL
      )`,
    );
  }

  async lease(sessionId: string, create: () => Promise<ManagedSession>): Promise<ManagedSessionLease> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      this.attachConnection(existing);
      return { managed: existing, resumed: true };
    }

    let pending = this.pendingLeases.get(sessionId);
    if (!pending) {
      pending = create().then((managed) => {
        const row = this.row(sessionId);
        if (row) {
          managed.currentContextId = row.current_context_id;
          managed.inputSequence.lastSequence = row.last_sequence;
        }
        this.sessions.set(sessionId, managed);
        this.persist(managed, 0);
        return managed;
      }).finally(() => {
        this.pendingLeases.delete(sessionId);
      });
      this.pendingLeases.set(sessionId, pending);
    }

    const row = this.row(sessionId);
    const managed = await pending;
    this.attachConnection(managed);
    return { managed, resumed: Boolean(row && row.retained_until_ms > Date.now()) };
  }

  async release(sessionId: string, retainMs: number): Promise<void> {
    const managed = this.sessions.get(sessionId);
    if (!managed) return;
    if (managed.connectionCount > 0) return;

    if (retainMs <= 0) {
      this.sessions.delete(sessionId);
      this.storage.sql.exec("DELETE FROM sessions WHERE id = ?", sessionId);
      await managed.session.close().catch(() => undefined);
      return;
    }

    const retainedUntilMs = Date.now() + retainMs;
    this.persist(managed, retainedUntilMs);
    this.scheduler.schedule(`session.retain:${sessionId}`, retainMs, async () => {
      const current = this.sessions.get(sessionId);
      if (!current || current.connectionCount > 0) return;
      this.sessions.delete(sessionId);
      this.storage.sql.exec("DELETE FROM sessions WHERE id = ?", sessionId);
      await current.session.close().catch(() => undefined);
    });
  }

  update(sessionId: string, mutate: (managed: ManagedSession) => void): void {
    const managed = this.sessions.get(sessionId);
    if (!managed) return;
    mutate(managed);
    this.persist(managed, 0);
  }

  async get(sessionId: string): Promise<ManagedSession | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async listAll(): Promise<readonly ManagedSession[]> {
    return [...this.sessions.values()];
  }

  async clear(): Promise<void> {
    for (const managed of this.sessions.values()) {
      await managed.session.close().catch(() => undefined);
    }
    this.sessions.clear();
    this.storage.sql.exec("DELETE FROM sessions");
  }

  private attachConnection(managed: ManagedSession): void {
    this.scheduler.cancel(`session.retain:${managed.id}`);
    managed.connectionCount += 1;
    this.persist(managed, 0);
  }

  private persist(managed: ManagedSession, retainedUntilMs: number): void {
    this.storage.sql.exec(
      `INSERT OR REPLACE INTO sessions
        (id, current_context_id, last_sequence, retained_until_ms, connection_count, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?)`,
      managed.id,
      managed.currentContextId,
      managed.inputSequence.lastSequence,
      retainedUntilMs,
      managed.connectionCount,
      Date.now(),
    );
  }

  private row(sessionId: string): SessionRow | null {
    const [row] = [...this.storage.sql.exec("SELECT * FROM sessions WHERE id = ?", sessionId)] as unknown as SessionRow[];
    return row ?? null;
  }
}
