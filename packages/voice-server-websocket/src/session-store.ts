// SPDX-License-Identifier: MIT

import type { VoiceAgentSession } from "@asyncdot/voice";

export interface AudioSequenceState {
  lastSequence: number | null;
}

export interface ManagedSession {
  readonly id: string;
  readonly session: VoiceAgentSession;
  currentContextId: string;
  readonly contextSampleRates: Map<string, number>;
  readonly inputSequence: AudioSequenceState;
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
  get(sessionId: string): Promise<ManagedSession | null>;
  listAll(): Promise<readonly ManagedSession[]>;
  clear(): Promise<void>;
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, ManagedSession>();

  async lease(sessionId: string, create: () => Promise<ManagedSession>): Promise<ManagedSessionLease> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      const resumed = existing.connectionCount > 0 || existing.closeTimer !== null;
      if (existing.closeTimer) {
        clearTimeout(existing.closeTimer);
        existing.closeTimer = null;
      }
      existing.connectionCount += 1;
      return { managed: existing, resumed };
    }
    const managed = await create();
    this.sessions.set(sessionId, managed);
    return { managed, resumed: false };
  }

  async release(sessionId: string, retainMs: number): Promise<void> {
    const managed = this.sessions.get(sessionId);
    if (!managed) return;
    if (managed.connectionCount > 0 || managed.closeTimer) return;
    if (retainMs <= 0) {
      this.sessions.delete(sessionId);
      await managed.session.close().catch(() => undefined);
      return;
    }
    managed.closeTimer = setTimeout(() => {
      managed.closeTimer = null;
      if (managed.connectionCount > 0) return;
      this.sessions.delete(sessionId);
      void managed.session.close().catch(() => undefined);
    }, retainMs);
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
}
