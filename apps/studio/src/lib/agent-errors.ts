// SPDX-License-Identifier: MIT
//
// The errors the server sent, kept and named.
//
// Every `error` message carries a component and a category, and both used to be
// thrown away — so "the agent stopped replying" could be the transcriber, the
// reasoner or the voice, and there was no way to tell which. This module is the
// part that can be tested without a socket: pull every error out of the record,
// and decide whether the session survived it.
//
// Severity is not on the wire. The server's own `isRecoverable` flag is dropped
// before the message is sent (voice-agent-session.ts records it to the debug
// stream only), so the studio has to re-derive it — and it must derive the *same*
// answer the session did, because that verdict is literally what decides whether
// the session closes:
//
//   - core's `isRecoverable(category)` is rate_limit and network_timeout, nothing
//     else (error-handler.ts:117), and `!recoverable` closes the session
//     (voice-agent-session.ts:1873).
//   - a `pipeline` error is always recoverable regardless of category: the bus
//     marks handler exceptions that way by design, so one misbehaving handler
//     degrades a turn instead of killing the call (pipeline-bus.ts:361).
//   - a `transport` + invalid_input error rejects one client message and keeps
//     going (server-websocket/index.ts:379 sends it and does not close).
//   - `session` + initialization/startup_timeout is the session never starting.
//
// Anything outside that set is `unknown` and says so, rather than being coloured
// green or red on a guess.

import type { SessionRecord } from "@kuralle-syrinx/browser-client/record";

export type ErrorSeverity = "recoverable" | "fatal" | "unknown";

export interface AgentError {
  /** ms since the record started, so it lines up with the timeline and event log. */
  readonly atMs: number;
  /** Absent for an error that arrived outside any turn — startup, transport. */
  readonly turnId?: string;
  readonly component?: string;
  readonly category?: string;
  readonly message: string;
  readonly severity: ErrorSeverity;
}

/** `llm.error` and `llm` are the same component; the suffix is a wire artefact. */
export function baseComponent(component: string | undefined): string | undefined {
  if (component === undefined) return undefined;
  return component.endsWith(".error") ? component.slice(0, -".error".length) : component;
}

const RECOVERABLE_CATEGORIES = new Set(["rate_limit", "network_timeout"]);
const FATAL_CATEGORIES = new Set([
  "authentication",
  "invalid_input",
  "internal_fault",
  "resource_exhausted",
]);

export function classifyErrorSeverity(
  component: string | undefined,
  category: string | undefined,
): ErrorSeverity {
  const base = baseComponent(component);
  if (base === "pipeline") return "recoverable";
  if (base === "session") {
    return category === "initialization" || category === "startup_timeout" ? "fatal" : "unknown";
  }
  if (base === "transport") {
    if (category === "invalid_input") return "recoverable";
    if (category === "session_timeout" || category === "idle_timeout") return "fatal";
    return "unknown";
  }
  if (category === undefined) return "unknown";
  if (RECOVERABLE_CATEGORIES.has(category)) return "recoverable";
  if (FATAL_CATEGORIES.has(category)) return "fatal";
  return "unknown";
}

/**
 * Every error in the record, newest first, each tied to the turn it belongs to.
 *
 * Both sources matter: an error carrying a turnId is folded into that turn, and
 * one without — a startup failure, a rejected frame — lands in the session
 * stream. Reading only turns would silently drop the second kind.
 */
export function collectAgentErrors(record: SessionRecord): readonly AgentError[] {
  const errors: AgentError[] = [];
  for (const turn of record.turns) {
    for (const error of turn.errors) {
      errors.push({
        atMs: error.atMs,
        turnId: turn.turnId,
        component: error.component,
        category: error.category,
        message: error.message,
        severity: classifyErrorSeverity(error.component, error.category),
      });
    }
  }
  for (const event of record.sessionEvents) {
    if (event.message.type !== "error") continue;
    const message = event.message as { component?: unknown; category?: unknown; message?: unknown };
    errors.push({
      atMs: event.atMs,
      component: typeof message.component === "string" ? message.component : undefined,
      category: typeof message.category === "string" ? message.category : undefined,
      message: typeof message.message === "string" ? message.message : "",
      severity: classifyErrorSeverity(
        typeof message.component === "string" ? message.component : undefined,
        typeof message.category === "string" ? message.category : undefined,
      ),
    });
  }
  return errors.sort((a, b) => b.atMs - a.atMs);
}
