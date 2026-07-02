// SPDX-License-Identifier: MIT
//
// G4 (RFC bimodel-delegate-seam) — durable reasoner session state over the
// Agent's DO-SQLite. Survives Durable Object eviction/hibernation, replacing
// consumer-side module-global memory stores (the SLIIT "F8" finding).

import type { ReasonerMessage, ReasonerSessionStore } from "@kuralle-syrinx/core";

/** The agents-SDK `Agent.sql` tagged-template surface (synchronous in the DO). */
export type SqlTag = <T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

interface HistoryRow {
  role: string;
  content: string;
  tool_call_id: string | null;
}

interface HandleRow {
  handle: string;
}

/**
 * `ReasonerSessionStore` backed by the Agent's SQLite. Also persists the latest
 * provider-native resume handle (Gemini `sessionResumption`) per session.
 */
export class SqliteReasonerSessionStore implements ReasonerSessionStore {
  constructor(private readonly sql: SqlTag) {
    this.sql`CREATE TABLE IF NOT EXISTS syrinx_reasoner_history (
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_call_id TEXT,
      PRIMARY KEY (session_id, seq)
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS syrinx_resume_handle (
      session_id TEXT PRIMARY KEY,
      handle TEXT NOT NULL
    )`;
  }

  load(sessionId: string): readonly ReasonerMessage[] {
    const rows = this.sql<HistoryRow>`
      SELECT role, content, tool_call_id FROM syrinx_reasoner_history
      WHERE session_id = ${sessionId} ORDER BY seq ASC`;
    return rows.map((row) => ({
      role: row.role as ReasonerMessage["role"],
      content: row.content,
      ...(row.tool_call_id ? { toolCallId: row.tool_call_id } : {}),
    }));
  }

  save(sessionId: string, messages: readonly ReasonerMessage[]): void {
    this.sql`DELETE FROM syrinx_reasoner_history WHERE session_id = ${sessionId}`;
    messages.forEach((message, seq) => {
      this.sql`INSERT INTO syrinx_reasoner_history (session_id, seq, role, content, tool_call_id)
        VALUES (${sessionId}, ${seq}, ${message.role}, ${message.content}, ${message.toolCallId ?? null})`;
    });
  }

  clear(sessionId: string): void {
    this.sql`DELETE FROM syrinx_reasoner_history WHERE session_id = ${sessionId}`;
    this.sql`DELETE FROM syrinx_resume_handle WHERE session_id = ${sessionId}`;
  }

  loadResumeHandle(sessionId: string): string | undefined {
    const rows = this.sql<HandleRow>`
      SELECT handle FROM syrinx_resume_handle WHERE session_id = ${sessionId}`;
    return rows[0]?.handle;
  }

  saveResumeHandle(sessionId: string, handle: string): void {
    this.sql`DELETE FROM syrinx_resume_handle WHERE session_id = ${sessionId}`;
    this.sql`INSERT INTO syrinx_resume_handle (session_id, handle) VALUES (${sessionId}, ${handle})`;
  }
}
