// SPDX-License-Identifier: MIT
//
// Dry structural test for the full-duplex examiner.
// Runs the loop with stubs (no providers), asserts N turns, valid metrics,
// and table rendering — the DoD exercise.

import { describe, expect, it } from "vitest";

import { resolveDailyTask } from "../scripts/examiner-goals.js";
import {
  computeTakeoverRate,
  isTakeover,
  stubJudgeTurn,
  DEFAULT_TOR_THRESHOLD_MS,
} from "../scripts/examiner-judge.js";
import {
  isDryMode,
  isJudgeMode,
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

describe("semantic judge helpers", () => {
  it("flags takeover when latency is below TOR threshold", () => {
    expect(isTakeover(DEFAULT_TOR_THRESHOLD_MS - 1)).toBe(true);
    expect(isTakeover(DEFAULT_TOR_THRESHOLD_MS)).toBe(false);
    expect(isTakeover(DEFAULT_TOR_THRESHOLD_MS + 50)).toBe(false);
  });

  it("computes takeover rate as fraction of eager turns", () => {
    expect(computeTakeoverRate([100, 500, 200, 800], 400)).toBe(0.5);
    expect(computeTakeoverRate([], 400)).toBe(0);
  });

  it("stub judge marks filler low and substantive high", () => {
    const filler = stubJudgeTurn({
      subGoal: "Book advising appointment",
      examinerUtterance: "I'd like to book advising",
      agentReply: "Are you still there?",
      responseLatencyMs: 150,
    });
    expect(filler.addressedGoal).toBe(false);
    expect(filler.instructionFollowing).toBeLessThanOrEqual(2);
    expect(filler.turnTakingFluency).toBeLessThanOrEqual(2);

    const good = stubJudgeTurn({
      subGoal: "Book advising appointment",
      examinerUtterance: "I'd like to book advising",
      agentReply:
        "I can help you book an advising appointment. Your advisor is Dr. Priya Raman.",
      responseLatencyMs: 900,
    });
    expect(good.addressedGoal).toBe(true);
    expect(good.instructionFollowing).toBeGreaterThanOrEqual(4);
    expect(good.turnTakingFluency).toBeGreaterThanOrEqual(3);
  });
});

describe("fullduplex examiner dry mode", () => {
  function dryOptions(): Parameters<typeof runFullduplexExaminer>[0] {
    return {
      dry: true,
      agentKind: "cascade",
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

    // Judge is opt-in: off by default → no judged block, no provider calls
    expect(result.judged).toBeUndefined();
  });

  it("judge-on + dry uses stub scores with no providers", { timeout: 15_000 }, async () => {
    const result = await runFullduplexExaminer({
      ...dryOptions(),
      judge: true,
    });

    expect(result.judged).toBeDefined();
    const judged = result.judged!;
    expect(judged.stub).toBe(true);
    expect(judged.turns.length).toBe(result.turns.length);
    expect(judged.torThresholdMs).toBe(DEFAULT_TOR_THRESHOLD_MS);

    for (const t of judged.turns) {
      expect(t.turnTakingFluency).toBeGreaterThanOrEqual(1);
      expect(t.turnTakingFluency).toBeLessThanOrEqual(5);
      expect(t.instructionFollowing).toBeGreaterThanOrEqual(1);
      expect(t.instructionFollowing).toBeLessThanOrEqual(5);
      expect(typeof t.addressedGoal).toBe("boolean");
      expect(typeof t.takeover).toBe("boolean");
      expect(t.note.length).toBeGreaterThan(0);
    }

    const agg = judged.aggregates;
    expect(agg.medianTurnTakingFluency).toBeGreaterThan(0);
    expect(agg.medianInstructionFollowing).toBeGreaterThan(0);
    expect(agg.addressedGoalRate).toBeGreaterThanOrEqual(0);
    expect(agg.addressedGoalRate).toBeLessThanOrEqual(1);
    expect(agg.takeoverRate).toBeGreaterThanOrEqual(0);
    expect(agg.takeoverRate).toBeLessThanOrEqual(1);

    // Dry canned replies are substantive → high addressed rate, TOR near zero
    expect(agg.addressedGoalRate).toBe(1);
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

  it("isJudgeMode detects env var and --judge", () => {
    expect(isJudgeMode(["--judge"])).toBe(true);
    expect(isJudgeMode([])).toBe(false);
    const prev = process.env["SYRINX_FDE_JUDGE"];
    process.env["SYRINX_FDE_JUDGE"] = "1";
    try {
      expect(isJudgeMode([])).toBe(true);
    } finally {
      if (prev === undefined) delete process.env["SYRINX_FDE_JUDGE"];
      else process.env["SYRINX_FDE_JUDGE"] = prev;
    }
  });
});
