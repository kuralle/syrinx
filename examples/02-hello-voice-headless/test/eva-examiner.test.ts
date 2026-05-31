// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyAccentPerturbation,
  applyNoisePerturbation,
  compareEvaToBaseline,
  evaluateEvaExaminer,
  scoreOverlap,
  scoreTurnTakingTiming,
  turnCapturesToTimeline,
  type EvaExaminerInput,
  type EvaExaminerScores,
} from "../scripts/eva-evaluator.js";

const FIXTURE_DIR = join(import.meta.dirname, "fixtures", "eva-examiner");

function loadFixture(name: string): EvaExaminerInput {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as EvaExaminerInput;
}

describe("eva examiner scoring", () => {
  it("scores known-good timeline higher than known-bad", () => {
    const good = evaluateEvaExaminer(loadFixture("known-good-timeline.json"));
    const bad = evaluateEvaExaminer(loadFixture("known-bad-timeline.json"));

    expect(good.scores.turnTakingTimingScore).toBeGreaterThan(bad.scores.turnTakingTimingScore);
    expect(good.scores.overlapScore).toBeGreaterThan(bad.scores.overlapScore);
    expect(good.failures).toEqual([]);
    expect(bad.failures.length).toBeGreaterThan(0);
    expect(bad.failures[0]).toContain("conversation overlap");
  });

  it("penalizes fast response and negative inter-turn gaps", () => {
    const timing = scoreTurnTakingTiming([
      {
        id: "t1",
        userSpeechStartMs: 0,
        userSpeechEndMs: 1000,
        assistantSpeechStartMs: 1050,
        assistantSpeechEndMs: 3000,
      },
      {
        id: "t2",
        userSpeechStartMs: 2900,
        userSpeechEndMs: 5000,
        assistantSpeechStartMs: 5100,
        assistantSpeechEndMs: 7000,
      },
    ]);
    expect(timing.score).toBeLessThan(100);
    expect(timing.minInterTurnGapMs).toBeLessThan(200);
  });

  it("scores zero overlap at 100 and heavy overlap lower", () => {
    expect(scoreOverlap(0, 60_000).score).toBe(100);
    expect(scoreOverlap(2000, 60_000).score).toBeLessThanOrEqual(50);
  });

  it("warns on baseline regression in warn mode and fails in block mode", () => {
    const baseline: EvaExaminerScores = {
      turnTakingTimingScore: 95,
      overlapScore: 100,
      avgResponseLatencyMs: 500,
      maxResponseLatencyMs: 700,
      minInterTurnGapMs: 2000,
      conversationOverlapMs: 0,
      overlapPercent: 0,
      perturbation: "clean",
    };
    const current: EvaExaminerScores = {
      ...baseline,
      turnTakingTimingScore: 70,
      conversationOverlapMs: 800,
    };
    const warn = compareEvaToBaseline(current, baseline, "warn");
    const block = compareEvaToBaseline(current, baseline, "block");
    expect(warn.warnings.length).toBeGreaterThan(0);
    expect(warn.failures).toEqual([]);
    expect(block.failures.length).toBeGreaterThan(0);
  });

  it("converts turn captures to relative timeline", () => {
    const timeline = turnCapturesToTimeline([
      {
        id: "a",
        startedAtMs: 1000,
        speechStartedAtMs: 1100,
        speechEndedAtMs: 5000,
        firstAudioAtMs: 5600,
        ttsEndedAtMs: 9000,
        assistantPlayoutEndMs: 9200,
      },
      {
        id: "b",
        startedAtMs: 12000,
        speechStartedAtMs: 12100,
        speechEndedAtMs: 15000,
        firstAudioAtMs: 15800,
        ttsEndedAtMs: 19000,
      },
    ]);
    expect(timeline[0]?.userSpeechStartMs).toBe(100);
    expect(timeline[1]?.userSpeechStartMs).toBe(11100);
    expect(timeline[1]?.assistantSpeechEndMs).toBe(18000);
  });

  it("applies noise and accent perturbations without empty output", () => {
    const samples = new Int16Array(1600);
    for (let i = 0; i < samples.length; i += 1) samples[i] = Math.sin(i / 20) * 8000;
    const noisy = applyNoisePerturbation(samples, 15);
    const accented = applyAccentPerturbation(samples, 1.08);
    expect(noisy.length).toBe(samples.length);
    expect(accented.length).toBeGreaterThan(0);
    expect(noisy.some((v, i) => v !== samples[i])).toBe(true);
  });
});
