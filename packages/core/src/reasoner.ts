// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Reasoner seam
//
// A reasoning backend reduced to one normalized pull-stream per turn. Frameworks
// (AI SDK ToolLoopAgent, Mastra Agent, raw streamText) become a Reasoner via
// adapters; the bridge drives the seam, not the framework. See RFC §4.2.

export interface ReasonerPrewarmContext {
  readonly sessionId: string;
  readonly systemPrompt?: string;
  readonly seedMessages?: readonly ReasonerMessage[];
}

/** The optional-capability surface. Adding here forces both wrappers to forward. */
export interface ReasonerCapabilities {
  prewarm?(ctx: ReasonerPrewarmContext): Promise<void>;
}

/** A reasoning backend reduced to one normalized pull-stream per turn. */
export interface Reasoner extends ReasonerCapabilities {
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

/** Wrappers implement every capability as REQUIRED — this is the enforcement. */
export type ComposedReasoner = Reasoner & Required<ReasonerCapabilities>;

export interface ReasonerTurn {
  /** Finalized user transcript for this turn (from `eos.turn_complete`). */
  readonly userText: string;
  /** Full prior conversation context. The BRIDGE owns history (see §4.5). */
  readonly messages: readonly ReasonerMessage[];
  /**
   * The front-model delegate tool-call arguments that triggered this turn, verbatim — so a
   * realtime front can pass structured context (e.g. `reply_language`) to the reasoner beyond
   * the extracted `userText`. Absent for cascade STT turns.
   */
  readonly toolArgs?: Record<string, unknown>;
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
  | { readonly type: "control"; readonly name: string; readonly payload: unknown }
  // A tool-authored payload for the client UI (a card, a link, a form) — data, not
  // speech. Rides the turn stream so its position against surrounding `text-delta`
  // parts is preserved for free (the deciding property — see the "reasoner reaches
  // the client" decision). `payload` MUST be JSON-serializable and size-bounded, and
  // MUST NEVER be spoken: the bridge routes it straight to the wire, never through TTS.
  // Barge-in drops it with the rest of the stream, same as every other part.
  | { readonly type: "client-message"; readonly payload: unknown }
  | { readonly type: "blocked"; readonly userFacingMessage: string; readonly payload?: unknown }
  // Human-in-the-loop pause (step 3). ALWAYS the terminal part for the turn.
  | { readonly type: "suspended"; readonly runId: string; readonly toolId?: string; readonly prompt?: string; readonly payload: unknown }
  // (B1) Error/abort the backend surfaced. The bridge treats `error` like today's
  // thrown TextStreamPart `error`/`tool-error`/`finish-step(error)`: it drives the
  // retry/`llm.error` path. `recoverable` mirrors `categorizeLlmError`. ALWAYS terminal.
  | { readonly type: "error"; readonly cause: Error; readonly recoverable: boolean }
  | {
      readonly type: "finish";
      readonly reason: "stop" | "tool" | "length";
      readonly text: string;
      /**
       * Billable token usage for this turn, when the backend reports it. Optional —
       * a reasoner that cannot report usage omits it, and the metering path treats a
       * missing field as "unknown", never zero. Consumed into `usage.recorded`.
       */
      readonly usage?: ReasonerUsage;
    };

/** Token usage a reasoner may attach to its terminal `finish` part. */
export interface ReasonerUsage {
  /** Provider slug (e.g. "openai"), for low-cardinality cost attribution. */
  readonly provider?: string;
  /** Model id (e.g. "gpt-4.1-mini"). Without this, spend cannot be attributed to a model. */
  readonly model?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cachedInputTokens?: number;
  readonly reasoningTokens?: number;
}
