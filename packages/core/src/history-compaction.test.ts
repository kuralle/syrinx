// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
  SummarizingHistoryCompactor,
  estimateHistoryTokens,
  safeCompactionBoundary,
} from "./history-compaction.js";
import type { Reasoner, ReasonerMessage, ReasonerTurn, ReasoningPart } from "./reasoner.js";

describe("estimateHistoryTokens", () => {
  it("estimates roughly chars/4 across all messages", () => {
    const history: ReasonerMessage[] = [
      { role: "system", content: "a".repeat(40) },
      { role: "user", content: "b".repeat(20) },
    ];
    expect(estimateHistoryTokens(history)).toBe(Math.ceil(60 / 4));
  });

  it("returns 0 for empty history", () => {
    expect(estimateHistoryTokens([])).toBe(0);
  });
});

describe("safeCompactionBoundary", () => {
  it("returns the desired boundary unchanged when no tool pair straddles it", () => {
    const history: ReasonerMessage[] = [
      { role: "system", content: "policy" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "bye" },
    ];
    expect(safeCompactionBoundary(history, 2)).toBe(2);
  });

  it("moves the boundary before a tool-call whose result lands on the other side", () => {
    const history: ReasonerMessage[] = [
      { role: "system", content: "policy" },
      { role: "user", content: "what's the fee?" },
      { role: "assistant", content: "", toolCallId: "call-1" },
      { role: "tool", content: "$10", toolCallId: "call-1" },
      { role: "assistant", content: "The fee is $10." },
    ];
    // Desired boundary of 3 lands between the call (index 2) and its result (index 3).
    expect(safeCompactionBoundary(history, 3)).toBe(2);
    // Landing exactly on the call itself is equally unsafe — must retreat further.
    expect(safeCompactionBoundary(history, 2)).toBe(2);
    // A boundary already past both halves, or entirely before both, is untouched.
    expect(safeCompactionBoundary(history, 4)).toBe(4);
    expect(safeCompactionBoundary(history, 1)).toBe(1);
  });

  it("resolves a chain of overlapping pairs by walking the boundary back until stable", () => {
    const history: ReasonerMessage[] = [
      { role: "assistant", content: "", toolCallId: "call-1" },
      { role: "assistant", content: "", toolCallId: "call-2" },
      { role: "tool", content: "r1", toolCallId: "call-1" },
      { role: "tool", content: "r2", toolCallId: "call-2" },
    ];
    // Desired boundary 3 splits call-2 (index 1) from its result (index 3); retreating to
    // 1 then re-splits call-1 (index 0) from its result (index 2), so it must retreat to 0.
    expect(safeCompactionBoundary(history, 3)).toBe(0);
  });

  it("clamps to [0, history.length]", () => {
    const history: ReasonerMessage[] = [{ role: "user", content: "hi" }];
    expect(safeCompactionBoundary(history, -5)).toBe(0);
    expect(safeCompactionBoundary(history, 50)).toBe(1);
  });
});

class FakeSummarizer implements Reasoner {
  capturedTurn: ReasonerTurn | undefined;
  constructor(private readonly parts: ReasoningPart[]) {}
  stream(turn: ReasonerTurn): AsyncIterable<ReasoningPart> {
    this.capturedTurn = turn;
    const parts = this.parts;
    return (async function* (): AsyncGenerator<ReasoningPart> {
      for (const part of parts) yield part;
    })();
  }
}

describe("SummarizingHistoryCompactor", () => {
  it("folds the prefix into a single retained system message", async () => {
    const summarizer = new FakeSummarizer([
      { type: "text-delta", text: "Caller opened a P1 outage ticket for org-42. " },
      { type: "text-delta", text: "Still waiting on a root cause." },
      { type: "finish", reason: "stop", text: "" },
    ]);
    const compactor = new SummarizingHistoryCompactor(summarizer);
    const result = await compactor.compact([
      { role: "system", content: "Support policy: always confirm org id." },
      { role: "user", content: "I have a P1 outage." },
      { role: "assistant", content: "Can you confirm your org id?" },
      { role: "user", content: "org-42" },
    ]);
    expect(result).toEqual([
      { role: "system", content: "Caller opened a P1 outage ticket for org-42. Still waiting on a root cause." },
    ]);
    expect(summarizer.capturedTurn?.messages).toHaveLength(1);
    expect(summarizer.capturedTurn?.messages[0]?.content).toContain("org-42");
  });

  it("returns an empty array for an empty prefix without calling the summarizer", async () => {
    let invoked = false;
    const summarizer: Reasoner = {
      stream: () => {
        invoked = true;
        return (async function* (): AsyncGenerator<ReasoningPart> {})();
      },
    };
    const compactor = new SummarizingHistoryCompactor(summarizer);
    expect(await compactor.compact([])).toEqual([]);
    expect(invoked).toBe(false);
  });

  it("propagates a summarizer error instead of silently dropping the prefix", async () => {
    const summarizer = new FakeSummarizer([
      { type: "error", cause: new Error("summarizer unavailable"), recoverable: true },
    ]);
    const compactor = new SummarizingHistoryCompactor(summarizer);
    await expect(compactor.compact([{ role: "user", content: "hi" }])).rejects.toThrow(
      "summarizer unavailable",
    );
  });
});
