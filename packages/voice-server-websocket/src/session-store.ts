// SPDX-License-Identifier: MIT

import type { VoiceAgentSession } from "@asyncdot/voice";
import type { TurnTimestampState } from "./turn-metrics.js";

export interface AudioSequenceState {
  lastSequence: number | null;
}

export interface ManagedSession {
  readonly id: string;
  readonly session: VoiceAgentSession;
  currentContextId: string;
  readonly contextSampleRates: Map<string, number>;
  readonly inputSequence: AudioSequenceState;
  readonly turnMetricsTurns: Map<string, TurnTimestampState>;
  closeTimer: ReturnType<typeof setTimeout> | null;
  connectionCount: number;
}

export interface ManagedSessionLease {
  readonly managed: ManagedSession;
  readonly resumed: boolean;
}

export interface SessionStore {
  lease(sessionId: string, create: () => Promise<ManagedSession>): Promise<ManagedSessionLease>;
  release(sessionId: string, retainMs: number): Promise<void>;
  update(sessionId: string, mutate: (managed: ManagedSession) => void): void;
  get(sessionId: string): Promise<ManagedSession | null>;
  listAll(): Promise<readonly ManagedSession[]>;
  clear(): Promise<void>;
}

interface PendingLease {
  readonly promise: Promise<ManagedSession>;
  waiters: number;
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly pendingLeases = new Map<string, PendingLease>();

  async lease(sessionId: string, create: () => Promise<ManagedSession>): Promise<ManagedSessionLease> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return this.attachConnection(existing, true);
    }

    let pending = this.pendingLeases.get(sessionId);
    if (!pending) {
      const promise = create()
        .then((managed) => {
          this.sessions.set(sessionId, managed);
          return managed;
        })
        .finally(() => {
          this.pendingLeases.delete(sessionId);
        });
      pending = { promise, waiters: 0 };
      this.pendingLeases.set(sessionId, pending);
    }

    const waiterIndex = pending.waiters;
    pending.waiters += 1;
    const managed = await pending.promise;
    if (waiterIndex === 0) {
      return { managed, resumed: false };
    }
    return this.attachConnection(managed, true);
  }

  async release(sessionId: string, retainMs: number): Promise<void> {
    const managed = this.sessions.get(sessionId);
    if (!managed) return;

    if (retainMs <= 0) {
      if (managed.closeTimer) {
        clearTimeout(managed.closeTimer);
        managed.closeTimer = null;
      }
      if (managed.connectionCount > 0) return;
      this.sessions.delete(sessionId);
      await managed.session.close().catch(() => undefined);
      return;
    }

    if (managed.connectionCount > 0 || managed.closeTimer) return;
    managed.closeTimer = setTimeout(() => {
      managed.closeTimer = null;
      if (managed.connectionCount > 0) return;
      this.sessions.delete(sessionId);
      void managed.session.close().catch(() => undefined);
    }, retainMs);
  }

  update(sessionId: string, mutate: (managed: ManagedSession) => void): void {
    const managed = this.sessions.get(sessionId);
    if (!managed) return;
    mutate(managed);
  }

  async get(sessionId: string): Promise<ManagedSession | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async listAll(): Promise<readonly ManagedSession[]> {
    return [...this.sessions.values()];
  }

  async clear(): Promise<void> {
    this.sessions.clear();
  }

  private attachConnection(managed: ManagedSession, resumed: boolean): ManagedSessionLease {
    if (managed.closeTimer) {
      clearTimeout(managed.closeTimer);
      managed.closeTimer = null;
    }
    managed.connectionCount += 1;
    return { managed, resumed };
  }
}
