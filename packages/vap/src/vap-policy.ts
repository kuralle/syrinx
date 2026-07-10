// SPDX-License-Identifier: MIT

import type { InteractionDecision, PluginConfig } from "@kuralle-syrinx/core";

export interface VapPredictor {
  initialize(cfg: PluginConfig): Promise<void>;
  predict(features: Float32Array): Promise<VapProbs>;
  close(): Promise<void>;
}

export interface VapProbs {
  readonly pShift: number;
  readonly pBackchannel: number;
  readonly pHold: number;
}

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

const DEFAULT_MAX_SAMPLES = 16_000;

export class RollingFeatureBuffer {
  private readonly storage: Float32Array;
  private length = 0;

  constructor(private readonly maxSamples = DEFAULT_MAX_SAMPLES) {
    this.storage = new Float32Array(maxSamples);
  }

  append(audio?: Int16Array): Float32Array {
    if (audio && audio.length > 0) {
      for (let i = 0; i < audio.length; i += 1) {
        const sample = audio[i] ?? 0;
        if (this.length >= this.maxSamples) {
          this.storage.copyWithin(0, 1);
          this.length = this.maxSamples - 1;
        }
        this.storage[this.length] = sample / 32768;
        this.length += 1;
      }
    }
    return this.storage.subarray(0, this.length);
  }

  reset(): void {
    this.length = 0;
  }
}