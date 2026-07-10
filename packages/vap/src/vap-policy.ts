// SPDX-License-Identifier: MIT

import type { InteractionDecision, InteractionObservation, PluginConfig } from "@kuralle-syrinx/core";

export interface VapPredictor {
  initialize(cfg: PluginConfig): Promise<void>;
  push(frame: VapPredictorFrame): Promise<VapProbs>;
  reset(contextId: string): void;
  close(): Promise<void>;
}

export interface VapPredictorFrame {
  readonly contextId: string;
  readonly timestampMs: number;
  readonly channel: "user" | "assistant";
  readonly audio: Int16Array;
  readonly sampleRateHz: number;
}

export interface VapProbs {
  readonly pShift: number;
  readonly pBackchannel: number;
  readonly pHold: number;
}

export type VapTranscriptObservation = Extract<
  InteractionObservation,
  { kind: "stt_partial" | "stt_final" }
>;

export type VapTranscriptFusion = (
  probs: VapProbs,
  transcript: VapTranscriptObservation,
) => VapProbs;

export interface VapThresholds {
  readonly shift: number;
  readonly backchannel: number;
  readonly take: number;
  readonly hold: number;
}

export const DEFAULT_VAP_THRESHOLDS: VapThresholds = {
  shift: 0.75,
  backchannel: 0.5,
  take: 0.6,
  hold: 0.5,
};

export const ZERO_VAP_PROBS: VapProbs = { pShift: 0, pBackchannel: 0, pHold: 0 };

export interface VapDecisionContext {
  readonly ttsActive: boolean;
  readonly ttsContextId: string;
  readonly delegateInFlight: boolean;
}

export function decideFromProbs(
  probs: VapProbs,
  ctx: VapDecisionContext,
  thresholds: VapThresholds = DEFAULT_VAP_THRESHOLDS,
): readonly InteractionDecision[] {
  if (ctx.ttsActive && probs.pShift > thresholds.shift) {
    return [{ kind: "interrupt", interruptedContextId: ctx.ttsContextId }];
  }
  if (probs.pBackchannel > thresholds.backchannel && ctx.delegateInFlight) {
    return [{ kind: "backchannel", cue: "mhmm" }];
  }
  if (probs.pShift > thresholds.take) {
    return [{ kind: "take_turn", confidence: probs.pShift }];
  }
  if (probs.pHold > thresholds.hold) {
    return [{ kind: "hold" }];
  }
  return [{ kind: "keep_listening" }];
}

/** Conservative transcript evidence used by the C6 VAP+STT arm. */
export function semanticTranscriptFusion(
  probs: VapProbs,
  transcript: VapTranscriptObservation,
): VapProbs {
  const text = transcript.text.trim().replace(/\s+/g, " ");
  if (!text) return probs;
  const incomplete = /\b(and|but|or|so|because|if|when|while|although|since|unless|until|the|a|an|to|for|of|in|on|at|with|about|from|by|please|just|also|then|well|um|uh|i|we|you|my|your|our|this)$/i.test(text)
    || text.endsWith(",");
  if (incomplete) return { ...probs, pShift: Math.min(probs.pShift, 0.49) };
  if (/[.!?]["')]*$/.test(text)) return { ...probs, pShift: Math.max(probs.pShift, 0.9) };
  return probs;
}

const DEFAULT_MAX_SAMPLES = 16_000;

export class RollingFeatureBuffer {
  private readonly storage: Float32Array;
  private length = 0;
  private writeIndex = 0;

  constructor(private readonly maxSamples = DEFAULT_MAX_SAMPLES) {
    this.storage = new Float32Array(maxSamples);
  }

  append(audio?: Int16Array): void {
    if (audio && audio.length > 0) {
      for (let i = 0; i < audio.length; i += 1) {
        const sample = audio[i] ?? 0;
        this.storage[this.writeIndex] = sample / 32768;
        this.writeIndex = (this.writeIndex + 1) % this.maxSamples;
        this.length = Math.min(this.length + 1, this.maxSamples);
      }
    }
  }

  /** Returns an immutable chronological copy suitable for async inference. */
  snapshot(): Float32Array {
    const snapshot = new Float32Array(this.length);
    const start = (this.writeIndex - this.length + this.maxSamples) % this.maxSamples;
    const firstLength = Math.min(this.length, this.maxSamples - start);
    snapshot.set(this.storage.subarray(start, start + firstLength));
    if (firstLength < this.length) {
      snapshot.set(this.storage.subarray(0, this.length - firstLength), firstLength);
    }
    return snapshot;
  }

  reset(): void {
    this.length = 0;
    this.writeIndex = 0;
  }
}
