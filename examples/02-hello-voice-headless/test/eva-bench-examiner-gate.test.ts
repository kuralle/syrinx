// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { evaluateEvaBenchExaminerGate } from "../scripts/run-eva-bench-examiner-smoke.js";
import type { EvaExaminerScores } from "../scripts/eva-evaluator.js";

function scores(overrides: Partial<EvaExaminerScores> = {}): EvaExaminerScores {
  return {
    turnTakingTimingScore: 95,
    overlapScore: 100,
    avgResponseLatencyMs: 600,
    maxResponseLatencyMs: 900,
    minInterTurnGapMs: 1500,
    conversationOverlapMs: 0,
    overlapPercent: 0,
    perturbation: "clean",
    ...overrides,
  };
}

describe("eva-bench examiner CI gate", () => {
  it("warns on regression in warn mode without failing", () => {
    const baseline = { clean: scores(), noise: scores({ perturbation: "noise", turnTakingTimingScore: 85 }) };
    const current = {
      clean: scores({ turnTakingTimingScore: 70 }),
      noise: scores({ perturbation: "noise", turnTakingTimingScore: 75 }),
      conversationOverlapMs: 200,
    };
    const gate = evaluateEvaBenchExaminerGate(current, baseline, "warn");
    expect(gate.failures).toEqual([]);
    expect(gate.warnings.some((w) => w.includes("turn-taking-timing regressed"))).toBe(true);
  });

  it("blocks on regression in block mode", () => {
    const baseline = { clean: scores(), noise: scores({ perturbation: "noise" }) };
    const current = {
      clean: scores({ turnTakingTimingScore: 60, conversationOverlapMs: 900 }),
      noise: scores({ perturbation: "noise" }),
      conversationOverlapMs: 900,
    };
    const gate = evaluateEvaBenchExaminerGate(current, baseline, "block");
    expect(gate.failures.length).toBeGreaterThan(0);
  });

  it("keeps checked-in baseline inside quality gates when present", () => {
    const root = join(import.meta.dirname, "..");
    let baseline: { qualityGate?: { passed?: boolean }; clean?: { turnTakingTimingScore?: number } };
    try {
      baseline = JSON.parse(
        readFileSync(join(root, "test", "performance", "eva-bench-examiner-baseline.json"), "utf8"),
      ) as typeof baseline;
    } catch {
      return;
    }
    expect(baseline.qualityGate?.passed).toBe(true);
    expect(baseline.clean?.turnTakingTimingScore ?? 0).toBeGreaterThanOrEqual(50);
  });
});
