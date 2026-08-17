// SPDX-License-Identifier: MIT
//
// HistoryCompactor seam — the managed transition that replaces a bare
// trimHistory() slice() (RFC: Continuous-interaction architecture §2.4/§4 L3).
// History is bridge-owned by design (reasoner.ts §4.5), so this seam lives in
// core rather than per-framework: fixing it here fixes every Reasoner adapter
// (Kuralle, Mastra, AI SDK) that plugs into the cascade bridge at once.

import type { Reasoner, ReasonerMessage } from "./reasoner.js";

/**
 * Pluggable compaction strategy. Called with the prefix that would otherwise be
 * silently dropped (oldest first) once history crosses the high-water mark; runs
 * OFF the turn path, after a turn has fully committed. Returns the messages that
 * replace that prefix — typically one retained `system` summary.
 */
export interface HistoryCompactor {
  compact(history: readonly ReasonerMessage[]): Promise<readonly ReasonerMessage[]>;
}

const DEFAULT_INSTRUCTION =
  "Summarize the conversation so far into a single concise system message a support " +
  "agent can resume the call from. Preserve every stated constraint, fact, decision, " +
  "and open question — these are load-bearing, not color. Drop pleasantries and small talk.";

/**
 * Default HistoryCompactor: hands the dropped prefix to a Reasoner and folds its
 * reply into one retained system message. Compaction runs off the live path and
 * recurs on every long call, so cost dominates latency — construct `summarizer`
 * through the existing RoutingReasoner machinery (reasoner-route.ts) to route it
 * at a cheap dedicated model rather than paying the session's frontier reasoner's
 * rate repeatedly for a mechanical summarization task.
 */
export class SummarizingHistoryCompactor implements HistoryCompactor {
  constructor(
    private readonly summarizer: Reasoner,
    private readonly opts: { readonly instruction?: string } = {},
  ) {}

  async compact(history: readonly ReasonerMessage[]): Promise<readonly ReasonerMessage[]> {
    if (history.length === 0) return [];
    const instruction = this.opts.instruction ?? DEFAULT_INSTRUCTION;
    const transcript = history
      .map((message) => `${message.role}${message.toolCallId ? ` (${message.toolCallId})` : ""}: ${message.content}`)
      .join("\n");
    const controller = new AbortController();
    let summary = "";
    for await (const part of this.summarizer.stream({
      userText: instruction,
      messages: [{ role: "user", content: `${instruction}\n\nConversation:\n${transcript}` }],
      signal: controller.signal,
    })) {
      if (part.type === "text-delta") {
        summary += part.text;
      } else if (part.type === "error") {
        throw part.cause;
      }
    }
    const trimmed = summary.trim();
    return trimmed.length > 0 ? [{ role: "system", content: trimmed }] : [];
  }
}

/** Rough token estimate (chars/4) — provider-agnostic, good enough for a trigger threshold. */
export function estimateHistoryTokens(history: readonly ReasonerMessage[]): number {
  let chars = 0;
  for (const message of history) chars += message.content.length;
  return Math.ceil(chars / 4);
}

/**
 * Moves `desired` earlier as needed so the boundary never lands between a
 * tool-call (an "assistant" message carrying `toolCallId`) and its matching
 * "tool" result. A pair with only one half on either side of the boundary is
 * pulled whole to the retained (post-boundary) side — adopted from Pipecat,
 * which marks an in-progress function call uninterruptible during summarization,
 * because a boundary split there produces a malformed sequence providers reject.
 */
export function safeCompactionBoundary(history: readonly ReasonerMessage[], desired: number): number {
  let boundary = Math.max(0, Math.min(desired, history.length));
  const pairs = new Map<string, { callIndex?: number; resultIndex?: number }>();
  history.forEach((message, index) => {
    if (message.toolCallId === undefined) return;
    const pair = pairs.get(message.toolCallId) ?? {};
    if (message.role === "assistant") pair.callIndex = index;
    if (message.role === "tool") pair.resultIndex = index;
    pairs.set(message.toolCallId, pair);
  });
  let changed = true;
  while (changed) {
    changed = false;
    for (const { callIndex, resultIndex } of pairs.values()) {
      if (callIndex === undefined || resultIndex === undefined) continue;
      const lo = Math.min(callIndex, resultIndex);
      const hi = Math.max(callIndex, resultIndex);
      if (boundary > lo && boundary <= hi) {
        boundary = lo;
        changed = true;
      }
    }
  }
  return boundary;
}
