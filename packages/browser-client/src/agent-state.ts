// SPDX-License-Identifier: MIT
//
// Conversational agent state, derived on the client from messages the server
// already sends. Distinct from `SessionState` in core, which is session
// *lifecycle* (uninitialized/ready/closed) — this is what the caller experiences:
// is it listening to me, thinking, or talking?
//
// A pause reads as "broken" without this. It is what a client renders as a
// listening indicator and what makes a turn timeline legible.
//
// Derived rather than sent: every signal already exists on the wire, so this
// needs no server change and works identically on Node and Workers.

import type { SyrinxStudioMessage } from "./index.js";

export type AgentState =
  | "idle"        // no session activity
  | "listening"   // user is speaking
  | "endpointing" // user stopped; deciding whether the turn is over
  | "thinking"    // reasoner (and any tools) running
  | "speaking"    // assistant audio playing
  | "interrupted"; // barge-in cut the assistant off

export interface AgentStateSnapshot {
  readonly state: AgentState;
  /** ms the state has been held, from the caller's clock. Lets a UI flag a stuck state. */
  readonly sinceMs: number;
  readonly turnId?: string;
}

type AnyMessage = { readonly type: string; readonly [k: string]: unknown };

/**
 * Fold one message into the state. Pure; the caller supplies the clock so this
 * stays deterministic under test.
 *
 * Ordering note: `speech_started` wins over everything, because a caller talking
 * is the highest-priority fact on the wire — that is also what makes barge-in
 * legible (speaking → listening without waiting for the interrupt message).
 */
export function nextAgentState(
  prev: AgentStateSnapshot,
  message: SyrinxStudioMessage | AnyMessage,
  atMs: number,
): AgentStateSnapshot {
  const type = typeof (message as AnyMessage).type === "string" ? (message as AnyMessage).type : "";
  const turnId = typeof (message as AnyMessage).turnId === "string" ? ((message as AnyMessage).turnId as string) : prev.turnId;
  const to = (state: AgentState): AgentStateSnapshot =>
    state === prev.state ? { ...prev, turnId } : { state, sinceMs: atMs, turnId };

  switch (type) {
    case "speech_started":
      return to("listening");
    case "speech_ended":
      // Speech stopped, but the turn is not necessarily over — this is exactly
      // the window where a premature endpoint cuts a caller off.
      return to("endpointing");
    case "stt_output":
    case "turn_complete":
      // A final transcript means the turn closed; the reasoner is now running.
      return to("thinking");
    case "agent_tool_call":
    case "tool_call_started":
    case "tool_call_delayed":
      return to("thinking");
    case "agent_chunk":
      // Text is arriving but nothing is audible yet.
      return prev.state === "speaking" ? to("speaking") : to("thinking");
    case "tts_chunk":
      return to("speaking");
    case "agent_interrupted":
      return to("interrupted");
    case "tts_end":
    case "agent_end":
      // Only settle to idle from a talking state; an interrupt stands until the
      // next turn starts, so the UI can show what happened.
      return prev.state === "speaking" ? to("idle") : prev;
    default:
      return prev;
  }
}

export const INITIAL_AGENT_STATE: AgentStateSnapshot = { state: "idle", sinceMs: 0 };

/** Fold a whole stream. Equivalent to repeated `nextAgentState`. */
export function deriveAgentState(
  messages: readonly { readonly message: SyrinxStudioMessage | AnyMessage; readonly atMs: number }[],
): AgentStateSnapshot {
  return messages.reduce((s, { message, atMs }) => nextAgentState(s, message, atMs), INITIAL_AGENT_STATE);
}

/**
 * How long a state may plausibly be held before it indicates a stall. A UI should
 * flag rather than hide these — a 30s "thinking" is a hung tool call, not patience.
 */
export const STATE_STALL_THRESHOLD_MS: Readonly<Record<AgentState, number>> = {
  idle: Number.POSITIVE_INFINITY,
  listening: 60_000,
  endpointing: 5_000,
  thinking: 30_000,
  speaking: 120_000,
  interrupted: 10_000,
};

export function isStalled(snapshot: AgentStateSnapshot, nowMs: number): boolean {
  return nowMs - snapshot.sinceMs > STATE_STALL_THRESHOLD_MS[snapshot.state];
}
