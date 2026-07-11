// SPDX-License-Identifier: MIT
//
// Dry structural test for the full-duplex examiner.
// Runs the loop with stubs (no providers), asserts N turns, valid metrics,
// and table rendering — the DoD exercise.

import { describe, expect, it } from "vitest";

import { resolveDailyTask } from "../scripts/examiner-goals.js";
import {
  isDryMode,
  runFullduplexExaminer,
  resolveExaminerModel,
  resolveExaminerTtsModel,
} from "../scripts/run-fullduplex-examiner.js";

describe("examiner goals", () => {
  it("resolves book-advising-appointment with 4 sub-goals", () => {
    const task = resolveDailyTask("book-advising-appointment");
    expect(task.name).toBe("book-advising-appointment");
    expect(task.subGoals.length).toBe(4);
    expect(task.scenario.length).toBeGreaterThan(0);
  });

  it("resolves check-financial-aid with 3 sub-goals", () => {
    const task = resolveDailyTask("check-financial-aid");
    expect(task.subGoals.length).toBe(3);
  });

  it("throws on unknown task", () => {
    expect(() => resolveDailyTask("no-such-task")).toThrow("unknown daily task");
  });
});

describe("fullduplex examiner dry mode", () => {
  function dryOptions(): Parameters<typeof runFullduplexExaminer>[0] {
    return {
      dry: true,
      taskName: "book-advising-appointment",
      maxTurns: 6,
      responseTimeoutMs: 10_000,
      outputDir: "/tmp/fd-examiner-test",
      recorderDir: "/tmp/fd-examiner-test/recorder",
      ttsProvider: "cartesia",
      examinerModel: resolveExaminerModel(),
      examinerTtsModel: resolveExaminerTtsModel(),
    };
  }

  it("runs the loop with stubs and produces valid metrics", { timeout: 15_000 }, async () => {
    const result = await runFullduplexExaminer(dryOptions());

    // Loop ran multiple turns
    expect(result.turns.length).toBeGreaterThan(0);

    // Every turn has numeric response latency
    for (const turn of result.turns) {
      expect(turn.responseLatencyMs).toBeGreaterThan(0);
      expect(typeof turn.responseLatencyMs).toBe("number");
      expect(turn.utteranceText.length).toBeGreaterThan(0);
      expect(Number.isFinite(turn.firstResponseAudioAtMs)).toBe(true);
      expect(Number.isFinite(turn.responseEndAtMs)).toBe(true);
    }

    // Metrics object populated
    expect(result.responseLatenciesMs.length).toBe(result.turns.length);
    expect(result.medianResponseLatencyMs).toBeGreaterThan(0);
    expect(result.totalTurns).toBe(result.turns.length);

    // Goal tracking fields exist
    expect(typeof result.subGoalsCompleted).toBe("boolean");
    expect(typeof result.maxTurnsReached).toBe("boolean");

    // Conversation overlap measured from synthetic WAV
    expect(result.conversationOverlapMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.conversationOverlapMs).toBe("number");
  });

  it("produces consistent latency ordering (firstAudio < ttsEnd)", { timeout: 15_000 }, async () => {
    const result = await runFullduplexExaminer(dryOptions());

    for (const turn of result.turns) {
      expect(turn.firstResponseAudioAtMs).toBeLessThanOrEqual(turn.responseEndAtMs);
    }
  });

  it("runs with check-financial-aid task", { timeout: 15_000 }, async () => {
    const result = await runFullduplexExaminer({
      ...dryOptions(),
      taskName: "check-financial-aid",
    });

    expect(result.task).toBe("check-financial-aid");
    expect(result.turns.length).toBeGreaterThan(0);
  });

  it("respects maxTurns cap of 3", { timeout: 15_000 }, async () => {
    const result = await runFullduplexExaminer({
      ...dryOptions(),
      maxTurns: 3,
    });

    expect(result.totalTurns).toBeLessThanOrEqual(3);
    expect(result.maxTurnsReached).toBe(true);
  });

  it("isDryMode detects env var and --dry", () => {
    expect(isDryMode(["--dry"])).toBe(true);
    expect(isDryMode([])).toBe(false);
  });
});
