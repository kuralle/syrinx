// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Reasoner seam
//
// A reasoning backend reduced to one normalized pull-stream per turn. Frameworks
// (AI SDK ToolLoopAgent, Mastra Agent, raw streamText) become a Reasoner via
// adapters; the bridge drives the seam, not the framework. See RFC §4.2.

/** A reasoning backend reduced to one normalized pull-stream per turn. */
export interface Reasoner {
  /**
   * Drive one reasoning turn. The returned async-iterable IS the response.
   * Cancellation (barge-in) is via `turn.signal` (abort) — the adapter forwards
   * it into the backend stream and into tool execution.
   *
   * LATENCY INVARIANT (non-negotiable, see §7a): the adapter MUST yield every
   * part the instant the backend produces it — NO buffering, NO awaiting the
   * stream to completion, NO batching. The first `text-delta` must reach the
   * caller as soon as the backend's first token lands. The seam adds at most one
   * microtask + a synchronous object remap per part; it must add no I/O hop.
   */
  stream(turn: ReasonerTurn): AsyncIterable<ReasoningPart>;
}

export interface ReasonerTurn {
  /** Finalized user transcript for this turn (from `eos.turn_complete`). */
  readonly userText: string;
  /** Full prior conversation context. The BRIDGE owns history (see §4.5). */
  readonly messages: readonly ReasonerMessage[];
  /** Barge-in / supersede cancellation. */
  readonly signal: AbortSignal;
  /** Present only when resuming a previously-suspended run (step 3). */
  readonly resume?: { readonly runId: string; readonly data: unknown };
}

export interface ReasonerMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCallId?: string;
}

/** Normalized output — the union of what AI SDK + Mastra can produce, minus noise. */
export type ReasoningPart =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "tool-call"; readonly toolId: string; readonly toolName: string; readonly args: Record<string, unknown> }
  | { readonly type: "tool-result"; readonly toolId: string; readonly toolName: string; readonly result: string }
  // Human-in-the-loop pause (step 3). ALWAYS the terminal part for the turn.
  | { readonly type: "suspended"; readonly runId: string; readonly toolId?: string; readonly prompt?: string; readonly payload: unknown }
  // (B1) Error/abort the backend surfaced. The bridge treats `error` like today's
  // thrown TextStreamPart `error`/`tool-error`/`finish-step(error)`: it drives the
  // retry/`llm.error` path. `recoverable` mirrors `categorizeLlmError`. ALWAYS terminal.
  | { readonly type: "error"; readonly cause: Error; readonly recoverable: boolean }
  | { readonly type: "finish"; readonly reason: "stop" | "tool" | "length"; readonly text: string };

