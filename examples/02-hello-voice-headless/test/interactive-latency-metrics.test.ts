// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
  assertNoNegativeNumbers,
  buildInteractiveLatencyAggregates,
  buildTurnLatencyMs,
  finalizeTurnMetrics,
  percentile,
  respondedAfterSpeechEndMs,
  speculativeLeadMs,
  type TurnLatencyInput,
} from "../scripts/interactive-latency-metrics.js";

interface SyntheticTurn extends TurnLatencyInput {
  readonly id: string;
}

function makeTurn(args: {
  readonly id: string;
  readonly speechEndedAtMs: number;
  readonly firstAudioAtMs: number;
  readonly sttFinalAtMs: number;
  readonly firstAgentAtMs: number;
  readonly audioEndedAtMs: number;
  readonly startedAtMs?: number;
  readonly ttsEndedAtMs?: number;
}): SyntheticTurn {
  return {
    id: args.id,
    startedAtMs: args.startedAtMs ?? 0,
    speechEndedAtMs: args.speechEndedAtMs,
    audioEndedAtMs: args.audioEndedAtMs,
    sttFinalAtMs: args.sttFinalAtMs,
    firstAgentAtMs: args.firstAgentAtMs,
    firstAudioAtMs: args.firstAudioAtMs,
    ttsEndedAtMs: args.ttsEndedAtMs ?? args.firstAudioAtMs + 500,
    metricsE2eMs: 0,
    speculativeLeadMs: 0,
  };
}

describe("interactive latency metrics", () => {
  it("splits speculative lead from post-speech-end voice-to-voice on a three-turn set", () => {
    const turns: SyntheticTurn[] = [
      makeTurn({
        id: "speculative",
        audioEndedAtMs: 4000,
        sttFinalAtMs: 5100,
        firstAgentAtMs: 4200,
        speechEndedAtMs: 5000,
        firstAudioAtMs: 4765,
      }),
      makeTurn({
        id: "normal",
        audioEndedAtMs: 4000,
        sttFinalAtMs: 4300,
        firstAgentAtMs: 4600,
        speechEndedAtMs: 5000,
        firstAudioAtMs: 5800,
      }),
      makeTurn({
        id: "cold-start",
        audioEndedAtMs: 4000,
        sttFinalAtMs: 5200,
        firstAgentAtMs: 6200,
        speechEndedAtMs: 5000,
        firstAudioAtMs: 9000,
      }),
    ];

    finalizeTurnMetrics(turns);

    expect(turns[0]!.speculativeLeadMs).toBe(235);
    expect(turns[0]!.metricsE2eMs).toBe(0);
    expect(turns[1]!.metricsE2eMs).toBe(800);
    expect(turns[2]!.metricsE2eMs).toBe(4000);

    const v2vPool = respondedAfterSpeechEndMs(turns);
    const speculativePool = speculativeLeadMs(turns);

    expect(v2vPool).toEqual([800, 4000]);
    expect(speculativePool).toEqual([235]);
    expect(v2vPool).not.toContain(235);
    expect(speculativePool).not.toContain(800);
    expect(speculativePool).not.toContain(4000);

    const speculativeLatency = buildTurnLatencyMs(turns[0]!);
    expect(speculativeLatency.speculativeLeadMs).toBe(235);
    expect(speculativeLatency.voiceToVoiceMs).toBeUndefined();
    expect(speculativeLatency.llmTimeToFirstText).toBeUndefined();

    const { latencyMs, diagnostics } = buildInteractiveLatencyAggregates(turns);

    expect(latencyMs.voiceToVoiceSampleCount).toBe(2);
    expect(latencyMs.speculativeTurnCount).toBe(1);
    expect(diagnostics).toContain("voice-to-voice sample count=2");
    expect(diagnostics).toContain("speculative lead sample count=1");
    expect(diagnostics).toContain("voice-to-voice percentile omitted: sample size 2 < 3");
    expect(diagnostics).toContain("speculative lead percentile omitted: sample size 1 < 3");

    expect(latencyMs.voiceToVoiceP50Ms).toBeNull();
    expect(latencyMs.voiceToVoiceP95Ms).toBeNull();
    expect(latencyMs.voiceToVoiceP99Ms).toBeNull();
    expect(latencyMs.speculativeLeadP50Ms).toBeNull();

    expect(latencyMs.avgLlmTimeToFirstText).toBeGreaterThanOrEqual(0);
    expect(latencyMs.avgTtsTimeToFirstAudio).toBeGreaterThanOrEqual(0);
    expect(latencyMs.avgSttFinalAfterSpeechEnd).toBeGreaterThanOrEqual(0);

    assertNoNegativeNumbers(latencyMs);
    assertNoNegativeNumbers(turns.map((turn) => buildTurnLatencyMs(turn)));
  });

  it("returns null for a two-sample percentile pool", () => {
    expect(percentile([800, 4000], 50)).toBeNull();
    expect(percentile([800, 4000], 95)).toBeNull();
  });
});
