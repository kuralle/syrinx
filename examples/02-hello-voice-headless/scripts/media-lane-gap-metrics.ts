// SPDX-License-Identifier: MIT
//
// Pure measurement logic for the media-lane inter-frame-gap harness.
// Unit-tested offline — no socket or provider dependency.

export const FRAME_CADENCE_MS = 20;
export const GAP_THRESHOLD_MS = 100;

export type Measured<T> =
  | { readonly state: "measured"; readonly value: T }
  | { readonly state: "unavailable"; readonly reason: string };

export type RunValidity =
  | { readonly state: "valid" }
  | { readonly state: "invalid"; readonly reasons: readonly string[] };

export interface AudioFrameSample {
  readonly arrivedAtMs: number;
  readonly durationMs: number;
}

export interface TurnLatencyWirePayload {
  readonly ttfaMs?: number;
  readonly anchor?: "speech_end" | "eos";
  readonly eouDelayMs?: number;
  readonly llmTtftMs?: number;
  readonly textAggregationMs?: number;
  readonly ttsTtfbMs?: number;
  readonly queuedMs?: number;
  readonly unattributedMs?: number;
  readonly llmCallCount?: number;
  readonly fillerUsed?: boolean;
}

export interface DurationShortfallReport {
  readonly expectedDurationMs: number;
  readonly actualDurationMs: number;
  readonly shortfallMs: number;
  readonly shortfallRatio: number;
  readonly flagged: boolean;
}

export interface RepeatAggregate {
  readonly perRun: readonly number[];
  readonly max: number;
  /** Present only when perRun.length > 1. */
  readonly median?: number;
  /** Present only when perRun.length === 1. */
  readonly value?: number;
  readonly validRunCount: number;
  readonly invalidRunCount: number;
}

export type GapThresholdVerdict =
  | {
      readonly thresholdMs: number;
      readonly largestGapMs: Measured<number>;
      readonly verdict: "passed" | "failed";
    }
  | {
      readonly thresholdMs: number;
      readonly largestGapMs: Measured<number>;
      readonly verdict: "inconclusive";
    };

export function computeLargestGapMs(timestampsMs: readonly number[]): Measured<number> {
  if (timestampsMs.length < 2) {
    return { state: "unavailable", reason: "fewer than 2 audio frame timestamps" };
  }
  let maxGap = 0;
  for (let index = 1; index < timestampsMs.length; index += 1) {
    const gap = timestampsMs[index]! - timestampsMs[index - 1]!;
    if (gap > maxGap) maxGap = gap;
  }
  return { state: "measured", value: maxGap };
}

export function filterTimestampsInWindow(
  timestampsMs: readonly number[],
  windowStartMs: number,
  windowEndMs: number,
): number[] {
  if (windowEndMs < windowStartMs) return [];
  return timestampsMs.filter((timestamp) => timestamp >= windowStartMs && timestamp <= windowEndMs);
}

export function computeLargestGapMsInWindow(
  timestampsMs: readonly number[],
  windowStartMs: number,
  windowEndMs: number,
): Measured<number> {
  return computeLargestGapMs(filterTimestampsInWindow(timestampsMs, windowStartMs, windowEndMs));
}

export function sumCarriedDurationMs(frames: readonly AudioFrameSample[]): number {
  return frames.reduce((sum, frame) => sum + frame.durationMs, 0);
}

export function evaluateDurationShortfall(
  frames: readonly AudioFrameSample[],
  expectedDurationMs: number,
): DurationShortfallReport {
  const actualDurationMs = sumCarriedDurationMs(frames);
  const shortfallMs = Math.max(0, expectedDurationMs - actualDurationMs);
  const shortfallRatio = expectedDurationMs > 0 ? shortfallMs / expectedDurationMs : 0;
  return {
    expectedDurationMs,
    actualDurationMs,
    shortfallMs,
    shortfallRatio,
    flagged: shortfallRatio >= 0.5,
  };
}

export function deriveQueuedMs(
  turnLatencyReceived: boolean,
  payload: TurnLatencyWirePayload | null | undefined,
): Measured<number> {
  if (!turnLatencyReceived) {
    return { state: "unavailable", reason: "turn_latency not received on the wire" };
  }
  if (
    payload &&
    typeof payload.queuedMs === "number" &&
    Number.isFinite(payload.queuedMs) &&
    payload.queuedMs > 0
  ) {
    return { state: "measured", value: payload.queuedMs };
  }
  return { state: "measured", value: 0 };
}

export function assessRunValidity(
  queuedMs: Measured<number>,
  largestGapMs: Measured<number>,
): RunValidity {
  const reasons: string[] = [];
  if (queuedMs.state === "unavailable") reasons.push(queuedMs.reason);
  if (largestGapMs.state === "unavailable") reasons.push(largestGapMs.reason);
  if (reasons.length > 0) return { state: "invalid", reasons };
  return { state: "valid" };
}

export function aggregateRepeats(values: readonly number[]): RepeatAggregate {
  if (values.length === 0) {
    return { perRun: [], max: 0, validRunCount: 0, invalidRunCount: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const max = sorted[sorted.length - 1] ?? 0;
  if (values.length === 1) {
    return { perRun: values, max, value: values[0]!, validRunCount: values.length, invalidRunCount: 0 };
  }
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2)
    : sorted[mid]!;
  return { perRun: values, max, median, validRunCount: values.length, invalidRunCount: 0 };
}

export function aggregateMeasuredRepeats(
  runs: readonly { readonly measured: Measured<number>; readonly runValidity: RunValidity }[],
): RepeatAggregate {
  const invalidRunCount = runs.filter((run) => run.runValidity.state === "invalid").length;
  const validValues = runs.flatMap((run) => {
    if (run.runValidity.state !== "valid" || run.measured.state !== "measured") return [];
    return [run.measured.value];
  });
  const aggregate = aggregateRepeats(validValues);
  return { ...aggregate, validRunCount: validValues.length, invalidRunCount };
}

export function evaluateGapThreshold(
  largestGapMs: Measured<number>,
  thresholdMs: number = GAP_THRESHOLD_MS,
): GapThresholdVerdict {
  if (largestGapMs.state === "unavailable") {
    return { thresholdMs, largestGapMs, verdict: "inconclusive" };
  }
  return {
    thresholdMs,
    largestGapMs,
    verdict: largestGapMs.value < thresholdMs ? "passed" : "failed",
  };
}

export function buildRegularArrivalSeries(frameCount: number, cadenceMs: number = FRAME_CADENCE_MS): number[] {
  const timestamps: number[] = [];
  for (let index = 0; index < frameCount; index += 1) {
    timestamps.push(index * cadenceMs);
  }
  return timestamps;
}

export function insertGapHole(
  timestampsMs: readonly number[],
  afterIndex: number,
  holeMs: number,
): number[] {
  const shifted = timestampsMs.map((timestamp, index) =>
    index > afterIndex ? timestamp + holeMs : timestamp,
  );
  return shifted;
}

export function formatMeasuredNumber(measured: Measured<number>): string {
  if (measured.state === "measured") return String(measured.value);
  return `unavailable (${measured.reason})`;
}
