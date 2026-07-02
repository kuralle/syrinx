// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — durable reasoner session state (G4, RFC bimodel-delegate-seam)
//
// The bridge owns conversation history (reasoner.ts §4.5); this seam makes that
// history durable so a reasoner resumes with the same context after a host
// eviction/reconnect instead of restarting amnesiac. Concrete backends: the
// in-memory impl below (Node/tests), a DO-SQLite impl in @kuralle-syrinx/cf-agents.

import type { ReasonerMessage } from "./reasoner.js";

/**
 * Durable per-session reasoner conversation history. `save` persists the full
 * (already bounded) history snapshot — snapshot semantics, not append, because
 * barge-in truncation rewrites earlier messages to the heard prefix (G25).
 */
export interface ReasonerSessionStore {
  load(sessionId: string): Promise<readonly ReasonerMessage[]> | readonly ReasonerMessage[];
  save(sessionId: string, messages: readonly ReasonerMessage[]): Promise<void> | void;
  clear(sessionId: string): Promise<void> | void;
}

export class InMemoryReasonerSessionStore implements ReasonerSessionStore {
  private readonly sessions = new Map<string, readonly ReasonerMessage[]>();

  load(sessionId: string): readonly ReasonerMessage[] {
    return this.sessions.get(sessionId) ?? [];
  }

  save(sessionId: string, messages: readonly ReasonerMessage[]): void {
    this.sessions.set(sessionId, [...messages]);
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
