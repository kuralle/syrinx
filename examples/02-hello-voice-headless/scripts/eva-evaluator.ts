// SPDX-License-Identifier: MIT
//
// VE-05: EVA-X turn-taking-timing + Full-Duplex-Bench overlap scoring for bot-to-bot examiner.

import { readFileSync } from "node:fs";

export interface EvaTurnTimeline {
  readonly id: string;
  readonly userSpeechStartMs: number;
  readonly userSpeechEndMs: number;
  readonly assistantSpeechStartMs: number;
  readonly assistantSpeechEndMs: number;
}

export interface EvaExaminerInput {
  readonly turns: readonly EvaTurnTimeline[];
  readonly conversationOverlapMs: number;
  readonly totalConversationMs: number;
  readonly perturbation: EvaPerturbationKind;
}

export type EvaPerturbationKind = "clean" | "noise" | "accent";
export type EvaGateMode = "warn" | "block";

export interface EvaExaminerScores {
  readonly turnTakingTimingScore: number;
  readonly overlapScore: number;
  readonly avgResponseLatencyMs: number;
  readonly maxResponseLatencyMs: number;
  readonly minInterTurnGapMs: number;
  readonly conversationOverlapMs: number;
  readonly overlapPercent: number;
  readonly perturbation: EvaPerturbationKind;
}

export interface EvaExaminerEvaluation {
  readonly scores: EvaExaminerScores;
  readonly failures: readonly string[];
  readonly warnings: readonly string[];
  readonly diagnostics: readonly string[];
}

export interface EvaTurnCaptureLike {
  readonly id: string;
  readonly speechStartedAtMs: number;
  readonly speechEndedAtMs: number;
  readonly firstAudioAtMs: number;
  readonly ttsEndedAtMs: number;
  readonly startedAtMs: number;
  readonly assistantPlayoutEndMs?: number;
}

export const MAX_CONVERSATION_OVERLAP_MS = 1500;
export const MIN_RESPONSE_LATENCY_MS = 80;
export const MAX_RESPONSE_LATENCY_MS = 8000;
export const MIN_INTER_TURN_GAP_MS = 200;
export const TIMING_REGRESSION_DELTA = 10;
export const OVERLAP_REGRESSION_MS = 500;

export function scoreTurnTakingTiming(turns: readonly EvaTurnTimeline[]): {
  score: number;
  avgResponseLatencyMs: number;
  maxResponseLatencyMs: number;
  minInterTurnGapMs: number;
} {
  if (turns.length === 0) {
    return { score: 0, avgResponseLatencyMs: 0, maxResponseLatencyMs: 0, minInterTurnGapMs: 0 };
  }

  const responseLatencies: number[] = [];
  const interTurnGaps: number[] = [];
  let penalty = 0;

  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i]!;
    const responseLatency = turn.assistantSpeechStartMs - turn.userSpeechEndMs;
    responseLatencies.push(responseLatency);
    if (responseLatency < MIN_RESPONSE_LATENCY_MS) penalty += 25;
    if (responseLatency > MAX_RESPONSE_LATENCY_MS) penalty += 20;
    if (turn.assistantSpeechStartMs < turn.userSpeechEndMs) penalty += 40;

    if (i > 0) {
      const prev = turns[i - 1]!;
      const gap = turn.userSpeechStartMs - prev.assistantSpeechEndMs;
      interTurnGaps.push(gap);
      if (gap < MIN_INTER_TURN_GAP_MS) penalty += 30;
      if (gap < 0) penalty += 50;
    }
  }

  const avgResponseLatencyMs = average(responseLatencies);
  const maxResponseLatencyMs = Math.max(...responseLatencies, 0);
  const minInterTurnGapMs = interTurnGaps.length > 0 ? Math.min(...interTurnGaps) : Number.POSITIVE_INFINITY;
  const score = Math.max(0, Math.min(100, 100 - penalty));
  return { score, avgResponseLatencyMs, maxResponseLatencyMs, minInterTurnGapMs };
}

export function scoreOverlap(conversationOverlapMs: number, totalConversationMs: number): {
  score: number;
  overlapPercent: number;
} {
  const overlapPercent = totalConversationMs > 0
    ? (conversationOverlapMs / totalConversationMs) * 100
    : 0;
  let penalty = 0;
  if (conversationOverlapMs > MAX_CONVERSATION_OVERLAP_MS) penalty += 50;
  else if (conversationOverlapMs > MAX_CONVERSATION_OVERLAP_MS / 2) penalty += 25;
  if (overlapPercent > 15) penalty += 20;
  const score = Math.max(0, Math.min(100, 100 - penalty));
  return { score, overlapPercent };
}

export function evaluateEvaExaminer(input: EvaExaminerInput): EvaExaminerEvaluation {
  const failures: string[] = [];
  const warnings: string[] = [];
  const diagnostics: string[] = [];

  if (input.turns.length === 0) failures.push("no turns in examiner timeline");

  const timing = scoreTurnTakingTiming(input.turns);
  const overlap = scoreOverlap(input.conversationOverlapMs, input.totalConversationMs);

  if (input.conversationOverlapMs > MAX_CONVERSATION_OVERLAP_MS) {
    failures.push(
      `conversation overlap ${input.conversationOverlapMs}ms exceeds ${MAX_CONVERSATION_OVERLAP_MS}ms`,
    );
  }
  if (timing.maxResponseLatencyMs > MAX_RESPONSE_LATENCY_MS) {
    warnings.push(
      `max response latency ${timing.maxResponseLatencyMs}ms exceeds ${MAX_RESPONSE_LATENCY_MS}ms`,
    );
  }
  if (Number.isFinite(timing.minInterTurnGapMs) && timing.minInterTurnGapMs < MIN_INTER_TURN_GAP_MS) {
    warnings.push(
      `min inter-turn gap ${timing.minInterTurnGapMs}ms below ${MIN_INTER_TURN_GAP_MS}ms polite floor`,
    );
  }
  if (input.perturbation !== "clean") {
    diagnostics.push(`perturbation=${input.perturbation}`);
    if (timing.score < 60) {
      warnings.push(`${input.perturbation} perturbation degraded turn-taking timing to ${timing.score}`);
    }
  }

  diagnostics.push(`turn-taking-timing score=${timing.score}`);
  diagnostics.push(`overlap score=${overlap.score}`);
  diagnostics.push(`avg response latency=${timing.avgResponseLatencyMs}ms`);
  diagnostics.push(`conversation overlap=${input.conversationOverlapMs}ms (${overlap.overlapPercent.toFixed(1)}%)`);

  const scores: EvaExaminerScores = {
    turnTakingTimingScore: timing.score,
    overlapScore: overlap.score,
    avgResponseLatencyMs: timing.avgResponseLatencyMs,
    maxResponseLatencyMs: timing.maxResponseLatencyMs,
    minInterTurnGapMs: Number.isFinite(timing.minInterTurnGapMs) ? timing.minInterTurnGapMs : 0,
    conversationOverlapMs: input.conversationOverlapMs,
    overlapPercent: overlap.overlapPercent,
    perturbation: input.perturbation,
  };

  return { scores, failures, warnings, diagnostics };
}

export function compareEvaToBaseline(
  current: EvaExaminerScores,
  baseline: EvaExaminerScores,
  mode: EvaGateMode,
): { failures: string[]; warnings: string[] } {
  const failures: string[] = [];
  const warnings: string[] = [];
  const regressions: string[] = [];

  if (current.turnTakingTimingScore < baseline.turnTakingTimingScore - TIMING_REGRESSION_DELTA) {
    regressions.push(
      `turn-taking-timing regressed ${baseline.turnTakingTimingScore}→${current.turnTakingTimingScore}`,
    );
  }
  if (current.overlapScore < baseline.overlapScore - TIMING_REGRESSION_DELTA) {
    regressions.push(`overlap score regressed ${baseline.overlapScore}→${current.overlapScore}`);
  }
  if (current.conversationOverlapMs > baseline.conversationOverlapMs + OVERLAP_REGRESSION_MS) {
    regressions.push(
      `conversation overlap regressed ${baseline.conversationOverlapMs}→${current.conversationOverlapMs}ms`,
    );
  }

  for (const msg of regressions) {
    if (mode === "block") failures.push(msg);
    else warnings.push(msg);
  }
  return { failures, warnings };
}

export function turnCapturesToTimeline(turns: readonly EvaTurnCaptureLike[]): EvaTurnTimeline[] {
  if (turns.length === 0) return [];
  const originMs = turns[0]!.startedAtMs;
  return turns.map((turn) => ({
    id: turn.id,
    userSpeechStartMs: Math.max(0, turn.speechStartedAtMs - originMs),
    userSpeechEndMs: Math.max(0, turn.speechEndedAtMs - originMs),
    assistantSpeechStartMs: Math.max(0, turn.firstAudioAtMs - originMs),
    assistantSpeechEndMs: Math.max(
      0,
      (turn.assistantPlayoutEndMs ?? turn.ttsEndedAtMs) - originMs,
    ),
  }));
}

export function measureStereoOverlapMs(wavPath: string): number {
  const buf = readFileSync(wavPath);
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  let off = 12;
  let dataOff = 44;
  let dataLen = buf.length - 44;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") {
      dataOff = off + 8;
      dataLen = size;
      break;
    }
    off += 8 + size + (size % 2);
  }
  if (channels !== 2 || bits !== 16) {
    throw new Error(`expected stereo s16 conversation.wav, got ${channels}ch ${bits}bit`);
  }
  const frames = Math.floor(dataLen / 4);
  const winFrames = Math.floor((100 * sampleRate) / 1000);
  const SPEECH_RMS = 300;
  const winRms = (startFrame: number, ch: number): number => {
    let sum = 0;
    let n = 0;
    for (let i = startFrame; i < Math.min(startFrame + winFrames, frames); i++) {
      const s = buf.readInt16LE(dataOff + i * 4 + ch * 2);
      sum += s * s;
      n++;
    }
    return n ? Math.sqrt(sum / n) : 0;
  };
  let overlapMs = 0;
  for (let f = 0; f < frames; f += winFrames) {
    if (winRms(f, 0) > SPEECH_RMS && winRms(f, 1) > SPEECH_RMS) overlapMs += 100;
  }
  return overlapMs;
}

export function applyNoisePerturbation(samples: Int16Array, snrDb: number): Int16Array {
  const out = new Int16Array(samples.length);
  let signalPower = 0;
  for (let i = 0; i < samples.length; i += 1) {
    signalPower += samples[i]! * samples[i]!;
  }
  signalPower = signalPower / Math.max(1, samples.length);
  const noisePower = signalPower / Math.pow(10, snrDb / 10);
  const noiseAmp = Math.sqrt(noisePower);
  for (let i = 0; i < samples.length; i += 1) {
    const noise = (Math.random() * 2 - 1) * noiseAmp;
    out[i] = clampInt16(samples[i]! + noise);
  }
  return out;
}

export function applyAccentPerturbation(samples: Int16Array, rateFactor: number): Int16Array {
  const outLen = Math.max(1, Math.floor(samples.length / rateFactor));
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    const srcIdx = Math.min(samples.length - 1, Math.floor(i * rateFactor));
    out[i] = samples[srcIdx]!;
  }
  return out;
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function clampInt16(value: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(value)));
}
