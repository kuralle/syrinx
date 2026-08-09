// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
  FRAME_CADENCE_MS,
  GAP_THRESHOLD_MS,
  aggregateMeasuredRepeats,
  aggregateRepeats,
  assessRunValidity,
  buildRegularArrivalSeries,
  computeLargestGapMs,
  computeLargestGapMsInWindow,
  deriveQueuedMs,
  evaluateDurationShortfall,
  evaluateGapThreshold,
  formatMeasuredNumber,
  insertGapHole,
  sumCarriedDurationMs,
  type AudioFrameSample,
  type Measured,
} from "../scripts/media-lane-gap-metrics.js";

describe("media lane gap metrics", () => {
  it("finds a deliberate 2000 ms hole in an arrival series", () => {
    const clean = buildRegularArrivalSeries(50, FRAME_CADENCE_MS);
    const withHole = insertGapHole(clean, 10, 2000);
    const gap = computeLargestGapMs(withHole);
    expect(gap).toEqual({ state: "measured", value: expect.any(Number) });
    if (gap.state === "measured") {
      expect(gap.value).toBeGreaterThanOrEqual(2000);
    }
  });

  it("reports a clean series gap near the frame cadence", () => {
    const clean = buildRegularArrivalSeries(50, FRAME_CADENCE_MS);
    const gap = computeLargestGapMs(clean);
    expect(gap).toEqual({ state: "measured", value: FRAME_CADENCE_MS });
  });

  it("flags half the expected carried audio duration", () => {
    const frames: AudioFrameSample[] = Array.from({ length: 10 }, (_, index) => ({
      arrivedAtMs: index * FRAME_CADENCE_MS,
      durationMs: FRAME_CADENCE_MS,
    }));
    const report = evaluateDurationShortfall(frames, 400);
    expect(report.actualDurationMs).toBe(200);
    expect(report.flagged).toBe(true);
    expect(report.shortfallRatio).toBe(0.5);
  });

  it("does not flag carried duration when frames match expectation", () => {
    const frames: AudioFrameSample[] = Array.from({ length: 20 }, (_, index) => ({
      arrivedAtMs: index * FRAME_CADENCE_MS,
      durationMs: FRAME_CADENCE_MS,
    }));
    const report = evaluateDurationShortfall(frames, sumCarriedDurationMs(frames));
    expect(report.flagged).toBe(false);
    expect(report.shortfallMs).toBe(0);
  });

  it("reports queuedMs unavailable when turn_latency was not received", () => {
    const queuedMs = deriveQueuedMs(false, null);
    expect(queuedMs).toEqual({
      state: "unavailable",
      reason: "turn_latency not received on the wire",
    });
    expect(formatMeasuredNumber(queuedMs)).not.toBe("0");
    const runValidity = assessRunValidity(queuedMs, { state: "measured", value: 20 });
    expect(runValidity).toEqual({
      state: "invalid",
      reasons: ["turn_latency not received on the wire"],
    });
  });

  it("reports measured zero when turn_latency arrived without queuedMs", () => {
    const queuedMs = deriveQueuedMs(true, { ttfaMs: 900, unattributedMs: 10 });
    expect(queuedMs).toEqual({ state: "measured", value: 0 });
    const runValidity = assessRunValidity(queuedMs, { state: "measured", value: 20 });
    expect(runValidity).toEqual({ state: "valid" });
  });

  it("reports measured queuedMs when turn_latency carried the field", () => {
    const queuedMs = deriveQueuedMs(true, { ttfaMs: 900, queuedMs: 42, unattributedMs: 1 });
    expect(queuedMs).toEqual({ state: "measured", value: 42 });
  });

  it("distinguishes absent turn_latency from present turn_latency with omitted queuedMs", () => {
    const absent = deriveQueuedMs(false, null);
    const presentOmitted = deriveQueuedMs(true, { ttfaMs: 500, unattributedMs: 0 });
    expect(absent.state).toBe("unavailable");
    expect(presentOmitted).toEqual({ state: "measured", value: 0 });
  });

  it("returns unavailable gap for fewer than two frames", () => {
    const gap = computeLargestGapMs([1000]);
    expect(gap).toEqual({
      state: "unavailable",
      reason: "fewer than 2 audio frame timestamps",
    });
    const verdict = evaluateGapThreshold(gap);
    expect(verdict.verdict).toBe("inconclusive");
  });

  it("reports a two-frame capture with a 2000 ms hole", () => {
    const gap = computeLargestGapMs([0, 2000]);
    expect(gap).toEqual({ state: "measured", value: 2000 });
  });

  it("reports median and max for multi-run aggregation of valid runs only", () => {
    const aggregate = aggregateMeasuredRepeats([
      { measured: { state: "measured", value: 80 }, runValidity: { state: "valid" } },
      { measured: { state: "measured", value: 40 }, runValidity: { state: "valid" } },
      { measured: { state: "measured", value: 120 }, runValidity: { state: "valid" } },
    ]);
    expect(aggregate.median).toBe(80);
    expect(aggregate.max).toBe(120);
    expect(aggregate.validRunCount).toBe(3);
    expect(aggregate.invalidRunCount).toBe(0);
    expect(aggregate.perRun).toEqual([80, 40, 120]);
  });

  it("does not include invalid runs in repeat aggregation median", () => {
    const aggregate = aggregateMeasuredRepeats([
      { measured: { state: "measured", value: 80 }, runValidity: { state: "valid" } },
      {
        measured: { state: "unavailable", reason: "turn_latency not received on the wire" },
        runValidity: { state: "invalid", reasons: ["turn_latency not received on the wire"] },
      },
      { measured: { state: "measured", value: 120 }, runValidity: { state: "valid" } },
    ]);
    expect(aggregate.validRunCount).toBe(2);
    expect(aggregate.invalidRunCount).toBe(1);
    expect(aggregate.median).toBe(100);
    expect(aggregate.perRun).toEqual([80, 120]);
  });

  it("does not report a median for a single valid run aggregation", () => {
    const aggregate = aggregateRepeats([55]);
    expect(aggregate.value).toBe(55);
    expect(aggregate.max).toBe(55);
    expect(aggregate.median).toBeUndefined();
    expect(aggregate.perRun).toEqual([55]);
  });

  it("computes largest gap only inside the tool window", () => {
    const timestamps = [0, 20, 40, 2060, 2080, 5000, 5020];
    const toolWindowGap = computeLargestGapMsInWindow(timestamps, 40, 2080);
    expect(toolWindowGap).toEqual({ state: "measured", value: 2020 });
    const fullGap = computeLargestGapMs(timestamps);
    if (fullGap.state === "measured" && toolWindowGap.state === "measured") {
      expect(fullGap.value).toBeGreaterThanOrEqual(toolWindowGap.value);
    }
  });

  it("evaluates the gap threshold with passed, failed, and inconclusive verdicts", () => {
    expect(evaluateGapThreshold({ state: "measured", value: 40 }).verdict).toBe("passed");
    expect(evaluateGapThreshold({ state: "measured", value: 120 }).verdict).toBe("failed");
    expect(evaluateGapThreshold({
      state: "unavailable",
      reason: "fewer than 2 audio frame timestamps",
    }).verdict).toBe("inconclusive");
    expect(evaluateGapThreshold({ state: "measured", value: 120 }).thresholdMs).toBe(GAP_THRESHOLD_MS);
  });
});

describe("media lane gap metrics — rule 6 sabotage", () => {
  it("failed to detect a 2000 ms hole when gap computation returned zero for insufficient samples", () => {
    const withHole = insertGapHole(buildRegularArrivalSeries(50, FRAME_CADENCE_MS), 10, 2000);
    const sabotaged = (): Measured<number> => ({ state: "measured", value: 0 });
    expect(sabotaged()).toEqual({ state: "measured", value: 0 });
    expect(computeLargestGapMs(withHole).state).toBe("measured");
    const restoredGap = computeLargestGapMs(withHole);
    if (restoredGap.state === "measured") {
      expect(restoredGap.value).toBeGreaterThanOrEqual(2000);
    }
  });

  it("failed to mark run invalid when absent turn_latency collapsed to measured zero", () => {
    const sabotaged = deriveQueuedMs(true, null);
    expect(sabotaged).toEqual({ state: "measured", value: 0 });
    expect(deriveQueuedMs(false, null).state).toBe("unavailable");
  });

  it("failed to return inconclusive when a single-frame capture reported passed", () => {
    const sabotaged = evaluateGapThreshold({ state: "measured", value: 0 });
    expect(sabotaged.verdict).toBe("passed");
    expect(evaluateGapThreshold(computeLargestGapMs([1000])).verdict).toBe("inconclusive");
  });

  it("failed to exclude invalid runs from aggregation when all runs were included", () => {
    const sabotaged = aggregateRepeats([80, 0, 120]);
    expect(sabotaged.perRun).toEqual([80, 0, 120]);
    const honest = aggregateMeasuredRepeats([
      { measured: { state: "measured", value: 80 }, runValidity: { state: "valid" } },
      {
        measured: { state: "unavailable", reason: "turn_latency not received on the wire" },
        runValidity: { state: "invalid", reasons: ["turn_latency not received on the wire"] },
      },
      { measured: { state: "measured", value: 120 }, runValidity: { state: "valid" } },
    ]);
    expect(honest.perRun).toEqual([80, 120]);
    expect(honest.invalidRunCount).toBe(1);
  });
});
