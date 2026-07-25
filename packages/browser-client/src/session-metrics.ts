// SPDX-License-Identifier: MIT
//
// Session-level latency aggregates. A one-off spike and a consistent regression
// look identical turn by turn; you need the distribution to tell them apart.
//
// Deliberately reports a FLOOR as well as a ceiling. A sub-second reply is the
// number every voice framework optimises for, and in a turn-taking system it is
// usually evidence the endpointer fired while the caller was still speaking.
// Celebrating it is how "fast" agents ship that interrupt people.

import type { TurnRecord, TurnTimings } from "./session-record.js";
import { FAST_TURN_FLOOR_MS } from "./turn-timeline.js";

export interface StageStats {
  readonly stage: string;
  readonly label: string;
  readonly count: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

export interface SessionMetrics {
  readonly turnCount: number;
  /** Turns that carried timings. The Workers path sends none, so this can be 0. */
  readonly measuredTurnCount: number;
  readonly stages: readonly StageStats[];
  /** Turns whose end-to-end fell below the floor — probable premature endpointing. */
  readonly suspiciouslyFastTurnIds: readonly string[];
  readonly floorMs: number;
  /** True when nothing could be measured, so the UI says why instead of showing zeroes. */
  readonly unavailable: boolean;
}

const STAGES: readonly { readonly key: keyof TurnTimings; readonly stage: string; readonly label: string }[] = [
  { key: "sttMs", stage: "stt", label: "Hearing you" },
  { key: "llmTTFTMs", stage: "llm", label: "Thinking (to first word)" },
  { key: "ttsTTFBMs", stage: "tts", label: "Voice (to first audio)" },
  { key: "e2eMs", stage: "e2e", label: "End to end" },
];

/**
 * Nearest-rank percentile. Chosen over interpolation deliberately: every value
 * reported is a real measurement that occurred, so a p95 can be traced back to
 * an actual turn rather than being a number no turn ever had.
 */
export function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[idx] ?? 0;
}

export function buildSessionMetrics(
  turns: readonly TurnRecord[],
  floorMs: number = FAST_TURN_FLOOR_MS,
): SessionMetrics {
  const measured = turns.filter((t) => t.timings !== undefined);

  const stages = STAGES.map(({ key, stage, label }) => {
    const values = measured
      .map((t) => t.timings?.[key])
      .filter((v): v is number => typeof v === "number")
      .sort((a, b) => a - b);
    return {
      stage,
      label,
      count: values.length,
      medianMs: percentile(values, 50),
      p95Ms: percentile(values, 95),
      maxMs: values.length > 0 ? (values[values.length - 1] ?? 0) : 0,
    };
  }).filter((s) => s.count > 0);

  const suspiciouslyFastTurnIds = measured
    .filter((t) => {
      const e2e = t.timings?.e2eMs;
      return typeof e2e === "number" && e2e > 0 && e2e < floorMs;
    })
    .map((t) => t.turnId);

  return {
    turnCount: turns.length,
    measuredTurnCount: measured.length,
    stages,
    suspiciouslyFastTurnIds,
    floorMs,
    unavailable: measured.length === 0,
  };
}
