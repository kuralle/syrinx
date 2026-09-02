// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import type { TurnRecord } from "./session-record.js";
import { buildSessionMetrics, percentile } from "./session-metrics.js";

const turn = (turnId: string, timings?: TurnRecord["timings"]): TurnRecord => ({
  turnId,
  startedAtMs: 0,
  events: [],
  agentText: "",
  toolCalls: [],
  ttsAudioBytes: 0,
  errors: [],
  complete: true,
  droppedEvents: 0,
  ...(timings ? { timings } : {}),
});

describe("percentile — nearest-rank", () => {
  it("returns a value that actually occurred", () => {
    const xs = [10, 20, 30, 40, 50];
    // Every result is a real measurement, traceable to a turn — not an interpolation.
    expect(xs).toContain(percentile(xs, 50));
    expect(xs).toContain(percentile(xs, 95));
  });

  it("handles the single-sample case", () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
  });

  it("returns 0 for an empty set rather than NaN", () => {
    expect(percentile([], 50)).toBe(0);
  });

  it("p95 lands on the top of the distribution", () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(xs, 95)).toBe(95);
  });
});

describe("session metrics — aggregates", () => {
  it("computes per-stage stats only for stages that have data", () => {
    const m = buildSessionMetrics([
      turn("t1", { eouDelayMs: 100, llmTtftMs: 900, ttfaMs: 1500 }),
      turn("t2", { eouDelayMs: 200, llmTtftMs: 1100, ttfaMs: 1900 }),
    ]);
    expect(m.stages.map((s) => s.stage)).toEqual(["stt", "llm", "e2e"]); // no tts data → no tts row
    // Nearest-rank, not interpolated: p50 of [100, 200] is 100, a turn that
    // actually happened — not 150, which no turn ever measured. Deliberate; do
    // not "correct" this to an average.
    expect(m.stages.find((s) => s.stage === "stt")?.medianMs).toBe(100);
    expect(m.stages.find((s) => s.stage === "e2e")?.maxMs).toBe(1900);
  });

  it("counts measured turns separately from total turns", () => {
    // The Workers path emits no metrics, so a session can have turns and no measurements.
    const m = buildSessionMetrics([turn("t1", { ttfaMs: 1200 }), turn("t2"), turn("t3")]);
    expect(m.turnCount).toBe(3);
    expect(m.measuredTurnCount).toBe(1);
    expect(m.unavailable).toBe(false);
  });

  it("reports unavailable when nothing carried timings", () => {
    const m = buildSessionMetrics([turn("t1"), turn("t2")]);
    expect(m.unavailable).toBe(true);
    expect(m.stages).toHaveLength(0);
    expect(m.turnCount).toBe(2); // still says how many turns happened
  });

  it("handles an empty session", () => {
    const m = buildSessionMetrics([]);
    expect(m.turnCount).toBe(0);
    expect(m.unavailable).toBe(true);
  });
});

describe("session metrics — the floor, not just the ceiling", () => {
  it("flags turns that replied implausibly fast", () => {
    const m = buildSessionMetrics([
      turn("slow", { ttfaMs: 2000 }),
      turn("premature", { ttfaMs: 420 }),
      turn("normal", { ttfaMs: 1100 }),
    ]);
    // 420ms is not a win — the endpointer almost certainly cut the caller off.
    expect(m.suspiciouslyFastTurnIds).toEqual(["premature"]);
    expect(m.floorMs).toBe(700);
  });

  it("does not flag a zero or missing e2e as fast", () => {
    const m = buildSessionMetrics([turn("a", { ttfaMs: 0 }), turn("b", { eouDelayMs: 50 })]);
    expect(m.suspiciouslyFastTurnIds).toEqual([]);
  });

  it("prefers ttfaPlayedMs over ttfaMs when both are present", () => {
    // ttfaPlayedMs (to audio actually played) is the number the caller experienced;
    // ttfaMs (to first byte) is a smaller/different number that must not shadow it.
    const m = buildSessionMetrics([turn("t1", { ttfaMs: 2000, ttfaPlayedMs: 420 })]);
    expect(m.suspiciouslyFastTurnIds).toEqual(["t1"]);
  });

  it("respects a caller-supplied floor", () => {
    // A triage agent talking to distressed callers wants a much higher floor.
    const m = buildSessionMetrics([turn("t1", { ttfaMs: 1500 })], 2000);
    expect(m.suspiciouslyFastTurnIds).toEqual(["t1"]);
  });
});
