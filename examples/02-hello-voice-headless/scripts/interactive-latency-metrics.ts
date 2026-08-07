// SPDX-License-Identifier: MIT

export const PERCENTILE_MIN_SAMPLE_SIZE = 3;

export interface TurnLatencyInput {
  startedAtMs: number;
  speechEndedAtMs: number;
  audioEndedAtMs: number;
  sttFinalAtMs: number;
  firstAgentAtMs: number;
  firstAudioAtMs: number;
  ttsEndedAtMs: number;
  metricsE2eMs: number;
  speculativeLeadMs: number;
}

export interface InteractiveLatencyAggregates {
  readonly latencyMs: Record<string, number | null>;
  readonly diagnostics: readonly string[];
}

export function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

export function averageRecorded(values: readonly number[]): { readonly avg: number; readonly sampleCount: number } {
  if (values.length === 0) return { avg: 0, sampleCount: 0 };
  return {
    avg: average(values),
    sampleCount: values.length,
  };
}

export function percentile(values: readonly number[], pct: number): number | null {
  if (values.length < PERCENTILE_MIN_SAMPLE_SIZE) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

export function percentileOmissionDiagnostic(seriesName: string, sampleSize: number): string {
  return `${seriesName} percentile omitted: sample size ${String(sampleSize)} < ${String(PERCENTILE_MIN_SAMPLE_SIZE)}`;
}

export function finalizeTurnMetrics(turns: readonly TurnLatencyInput[]): { readonly speculativeTurnCount: number } {
  let speculativeTurnCount = 0;
  for (const turn of turns) {
    const voiceToVoiceMs = turn.firstAudioAtMs - turn.speechEndedAtMs;
    if (voiceToVoiceMs > 0) {
      turn.metricsE2eMs = voiceToVoiceMs;
      turn.speculativeLeadMs = 0;
      continue;
    }
    turn.metricsE2eMs = 0;
    if (voiceToVoiceMs < 0 && turn.firstAudioAtMs > 0 && turn.speechEndedAtMs > 0) {
      turn.speculativeLeadMs = turn.speechEndedAtMs - turn.firstAudioAtMs;
      speculativeTurnCount += 1;
      continue;
    }
    turn.speculativeLeadMs = 0;
  }
  return { speculativeTurnCount };
}

export function respondedAfterSpeechEndMs(turns: readonly TurnLatencyInput[]): number[] {
  return turns.map((turn) => turn.metricsE2eMs).filter((value) => value > 0);
}

export function speculativeLeadMs(turns: readonly TurnLatencyInput[]): number[] {
  return turns.map((turn) => turn.speculativeLeadMs).filter((value) => value > 0);
}

function positiveDeltas(
  turns: readonly TurnLatencyInput[],
  fn: (turn: TurnLatencyInput) => number,
): number[] {
  return turns.map(fn).filter((value) => value > 0);
}

function collectRecordedTurnValues(
  turns: readonly TurnLatencyInput[],
  key: string,
): number[] {
  return turns
    .map((turn) => buildTurnLatencyMs(turn)[key])
    .filter((value): value is number => typeof value === "number");
}

export function buildTurnLatencyMs(turn: TurnLatencyInput): Record<string, number> {
  const latencyMs: Record<string, number> = {};
  const sttFinalAfterSpeechEnd = turn.sttFinalAtMs - turn.audioEndedAtMs;
  const vadSpeechEndAfterAudioEnd = turn.speechEndedAtMs - turn.audioEndedAtMs;
  const llmTimeToFirstText = turn.firstAgentAtMs - turn.sttFinalAtMs;
  const ttsTimeToFirstAudio = turn.firstAudioAtMs - turn.firstAgentAtMs;
  const speechEndToFirstAssistantAudio = turn.firstAudioAtMs - turn.audioEndedAtMs;
  const vadSpeechEndToFirstAssistantAudio = turn.firstAudioAtMs - turn.speechEndedAtMs;
  const turnWallClock = turn.ttsEndedAtMs - turn.startedAtMs;
  if (sttFinalAfterSpeechEnd >= 0) latencyMs.sttFinalAfterSpeechEnd = sttFinalAfterSpeechEnd;
  if (vadSpeechEndAfterAudioEnd >= 0) latencyMs.vadSpeechEndAfterAudioEnd = vadSpeechEndAfterAudioEnd;
  if (llmTimeToFirstText >= 0) latencyMs.llmTimeToFirstText = llmTimeToFirstText;
  if (ttsTimeToFirstAudio >= 0) latencyMs.ttsTimeToFirstAudio = ttsTimeToFirstAudio;
  if (speechEndToFirstAssistantAudio >= 0) latencyMs.speechEndToFirstAssistantAudio = speechEndToFirstAssistantAudio;
  if (vadSpeechEndToFirstAssistantAudio >= 0) latencyMs.vadSpeechEndToFirstAssistantAudio = vadSpeechEndToFirstAssistantAudio;
  if (turnWallClock >= 0) latencyMs.turnWallClock = turnWallClock;
  if (turn.metricsE2eMs > 0) latencyMs.voiceToVoiceMs = turn.metricsE2eMs;
  if (turn.speculativeLeadMs > 0) latencyMs.speculativeLeadMs = turn.speculativeLeadMs;
  return latencyMs;
}

function appendPercentileDiagnostics(
  diagnostics: string[],
  seriesName: string,
  pool: readonly number[],
  keys: readonly { pct: number; key: string }[],
  latencyMs: Record<string, number | null>,
): void {
  for (const { pct, key } of keys) {
    latencyMs[key] = percentile(pool, pct);
  }
  if (pool.length < PERCENTILE_MIN_SAMPLE_SIZE) {
    diagnostics.push(percentileOmissionDiagnostic(seriesName, pool.length));
  }
}

export function buildInteractiveLatencyAggregates(
  turns: readonly TurnLatencyInput[],
): InteractiveLatencyAggregates {
  const diagnostics: string[] = [];
  const latencyMs: Record<string, number | null> = {};

  const v2vPool = respondedAfterSpeechEndMs(turns);
  const speculativePool = speculativeLeadMs(turns);
  diagnostics.push(`voice-to-voice sample count=${String(v2vPool.length)}`);
  diagnostics.push(`speculative lead sample count=${String(speculativePool.length)}`);

  const avgStt = averageRecorded(collectRecordedTurnValues(turns, "sttFinalAfterSpeechEnd"));
  latencyMs.avgSttFinalAfterSpeechEnd = avgStt.avg;
  latencyMs.avgSttFinalAfterSpeechEndSampleCount = avgStt.sampleCount;

  const avgVadEnd = averageRecorded(collectRecordedTurnValues(turns, "vadSpeechEndAfterAudioEnd"));
  latencyMs.avgVadSpeechEndAfterAudioEnd = avgVadEnd.avg;
  latencyMs.avgVadSpeechEndAfterAudioEndSampleCount = avgVadEnd.sampleCount;

  const avgLlm = averageRecorded(collectRecordedTurnValues(turns, "llmTimeToFirstText"));
  latencyMs.avgLlmTimeToFirstText = avgLlm.avg;
  latencyMs.avgLlmTimeToFirstTextSampleCount = avgLlm.sampleCount;

  const avgTts = averageRecorded(collectRecordedTurnValues(turns, "ttsTimeToFirstAudio"));
  latencyMs.avgTtsTimeToFirstAudio = avgTts.avg;
  latencyMs.avgTtsTimeToFirstAudioSampleCount = avgTts.sampleCount;

  const avgSpeechEnd = averageRecorded(collectRecordedTurnValues(turns, "speechEndToFirstAssistantAudio"));
  latencyMs.avgSpeechEndToFirstAssistantAudio = avgSpeechEnd.avg;
  latencyMs.avgSpeechEndToFirstAssistantAudioSampleCount = avgSpeechEnd.sampleCount;

  const avgVadSpeechEnd = averageRecorded(collectRecordedTurnValues(turns, "vadSpeechEndToFirstAssistantAudio"));
  latencyMs.avgVadSpeechEndToFirstAssistantAudio = avgVadSpeechEnd.avg;
  latencyMs.avgVadSpeechEndToFirstAssistantAudioSampleCount = avgVadSpeechEnd.sampleCount;

  latencyMs.voiceToVoiceSampleCount = v2vPool.length;
  appendPercentileDiagnostics(diagnostics, "voice-to-voice", v2vPool, [
    { pct: 50, key: "voiceToVoiceP50Ms" },
    { pct: 95, key: "voiceToVoiceP95Ms" },
    { pct: 99, key: "voiceToVoiceP99Ms" },
  ], latencyMs);

  latencyMs.speculativeTurnCount = speculativePool.length;
  appendPercentileDiagnostics(diagnostics, "speculative lead", speculativePool, [
    { pct: 50, key: "speculativeLeadP50Ms" },
    { pct: 95, key: "speculativeLeadP95Ms" },
    { pct: 99, key: "speculativeLeadP99Ms" },
  ], latencyMs);

  const sttFinalPool = positiveDeltas(turns, (turn) => turn.sttFinalAtMs - turn.audioEndedAtMs);
  appendPercentileDiagnostics(diagnostics, "STT-final", sttFinalPool, [
    { pct: 50, key: "sttFinalP50Ms" },
    { pct: 95, key: "sttFinalP95Ms" },
    { pct: 99, key: "sttFinalP99Ms" },
  ], latencyMs);

  const llmTtftPool = positiveDeltas(turns, (turn) => turn.firstAgentAtMs - turn.sttFinalAtMs);
  appendPercentileDiagnostics(diagnostics, "LLM-TTFT", llmTtftPool, [
    { pct: 50, key: "llmTtftP50Ms" },
    { pct: 95, key: "llmTtftP95Ms" },
    { pct: 99, key: "llmTtftP99Ms" },
  ], latencyMs);

  const ttsTtfbPool = positiveDeltas(turns, (turn) => turn.firstAudioAtMs - turn.firstAgentAtMs);
  appendPercentileDiagnostics(diagnostics, "TTS-TTFB", ttsTtfbPool, [
    { pct: 50, key: "ttsTtfbP50Ms" },
    { pct: 95, key: "ttsTtfbP95Ms" },
    { pct: 99, key: "ttsTtfbP99Ms" },
  ], latencyMs);

  return { latencyMs, diagnostics };
}

export function assertNoNegativeNumbers(value: unknown, path = "root"): void {
  if (value === null || value === undefined) return;
  if (typeof value === "number") {
    if (value < 0) throw new Error(`negative value at ${path}: ${String(value)}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoNegativeNumbers(entry, `${path}[${String(index)}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      assertNoNegativeNumbers(entry, `${path}.${key}`);
    }
  }
}
