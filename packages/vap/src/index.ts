// SPDX-License-Identifier: MIT

import type { PluginConfig } from "@kuralle-syrinx/core";
import type {
  AcousticSignalSink,
  InteractionDecision,
  InteractionObservation,
  InteractionPolicy,
} from "@kuralle-syrinx/core";
import {
  DEFAULT_VAP_THRESHOLDS,
  RollingFeatureBuffer,
  ZERO_VAP_PROBS,
  decideFromProbs,
  type VapDecisionContext,
  type VapPredictor,
  type VapPredictorFrame,
  type VapProbs,
  type VapThresholds,
  type VapTranscriptFusion,
  type VapTranscriptObservation,
} from "./vap-policy.js";

export type {
  VapPredictor,
  VapPredictorFrame,
  VapProbs,
  VapThresholds,
  VapDecisionContext,
  VapTranscriptFusion,
  VapTranscriptObservation,
} from "./vap-policy.js";
export {
  DEFAULT_VAP_THRESHOLDS,
  ZERO_VAP_PROBS,
  decideFromProbs,
  RollingFeatureBuffer,
  semanticTranscriptFusion,
} from "./vap-policy.js";

export { LocalVapPredictor } from "./dualturn-predictor.js";

export class StubVapPredictor implements VapPredictor {
  private scripted: VapProbs[] = [];
  private fallback: VapProbs = ZERO_VAP_PROBS;

  script(probs: readonly VapProbs[]): void {
    this.scripted = [...probs];
  }

  setFallback(probs: VapProbs): void {
    this.fallback = probs;
  }

  async initialize(_cfg: PluginConfig = {}): Promise<void> {}

  async push(_frame: VapPredictorFrame): Promise<VapProbs> {
    return this.scripted.shift() ?? this.fallback;
  }

  reset(_contextId: string): void {}

  async close(): Promise<void> {}
}

export interface VapInteractionPolicyDeps {
  readonly predictor: VapPredictor;
  readonly thresholds?: VapThresholds;
  readonly fuseTranscript?: VapTranscriptFusion;
}

export class VapInteractionPolicy implements InteractionPolicy {
  private readonly predictor: VapPredictor;
  private readonly thresholds: VapThresholds;
  private readonly fuseTranscript?: VapTranscriptFusion;
  private readonly cachedProbs = new Map<string, VapProbs>();
  private readonly transcripts = new Map<string, VapTranscriptObservation>();
  private readonly inferenceChains = new Map<string, Promise<void>>();
  private readonly contextEpochs = new Map<string, number>();
  private ttsActive = false;
  private ttsContextId = "";
  private delegateInFlight = false;
  private initialized = false;
  private acousticSignalSink: AcousticSignalSink | undefined;

  constructor(deps: VapInteractionPolicyDeps) {
    this.predictor = deps.predictor;
    this.thresholds = deps.thresholds ?? DEFAULT_VAP_THRESHOLDS;
    this.fuseTranscript = deps.fuseTranscript;
  }

  async initialize(cfg: PluginConfig = {}): Promise<void> {
    await this.predictor.initialize(cfg);
    this.initialized = true;
  }

  setAcousticSignalSink(sink: AcousticSignalSink): void {
    this.acousticSignalSink = sink;
  }

  observe(obs: InteractionObservation): readonly InteractionDecision[] {
    switch (obs.kind) {
      case "playout_tick":
        this.ttsActive = obs.ttsActive === true;
        if (this.ttsActive) this.ttsContextId = obs.contextId;
        if (obs.audio && obs.audio.length > 0) {
          this.enqueueInference({
            contextId: obs.contextId,
            timestampMs: obs.timestampMs,
            channel: "assistant",
            audio: obs.audio,
            sampleRateHz: obs.sampleRateHz ?? 16_000,
          });
        }
        return [];
      case "delegate_state":
        this.delegateInFlight = obs.delegateInFlight === true;
        return [];
      case "stt_partial":
      case "stt_final":
        this.transcripts.set(obs.contextId, obs);
        return [];
      case "audio_frame":
        return this.observeAudioFrame(obs);
      default:
        return [];
    }
  }

  reset(contextId: string): void {
    if (this.inferenceChains.has(contextId)) {
      this.contextEpochs.set(contextId, (this.contextEpochs.get(contextId) ?? 0) + 1);
    } else {
      this.contextEpochs.delete(contextId);
    }
    this.cachedProbs.delete(contextId);
    this.transcripts.delete(contextId);
    this.predictor.reset(contextId);
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.inferenceChains.values());
    await this.predictor.close();
    this.cachedProbs.clear();
    this.transcripts.clear();
    this.inferenceChains.clear();
    this.contextEpochs.clear();
    this.initialized = false;
    this.acousticSignalSink = undefined;
  }

  private observeAudioFrame(
    obs: Extract<InteractionObservation, { kind: "audio_frame" }>,
  ): readonly InteractionDecision[] {
    if (!this.initialized) return [{ kind: "keep_listening" }];
    if (obs.audio && obs.audio.length > 0) {
      this.enqueueInference({
        contextId: obs.contextId,
        timestampMs: obs.timestampMs,
        channel: "user",
        audio: obs.audio,
        sampleRateHz: obs.sampleRateHz ?? 16_000,
      });
    }
    const rawProbs = this.cachedProbs.get(obs.contextId) ?? ZERO_VAP_PROBS;
    const transcript = this.transcripts.get(obs.contextId);
    const probs = transcript && this.fuseTranscript
      ? this.fuseTranscript(rawProbs, transcript)
      : rawProbs;
    return decideFromProbs(probs, this.decisionContext());
  }

  private decisionContext(): VapDecisionContext {
    return {
      ttsActive: this.ttsActive,
      ttsContextId: this.ttsContextId,
      delegateInFlight: this.delegateInFlight,
    };
  }

  private enqueueInference(frame: VapPredictorFrame): void {
    const stableFrame = { ...frame, audio: frame.audio.slice() };
    const epoch = this.contextEpochs.get(frame.contextId) ?? 0;
    const previous = this.inferenceChains.get(frame.contextId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        if ((this.contextEpochs.get(frame.contextId) ?? 0) !== epoch) return;
        const probs = await this.predictor.push(stableFrame);
        if ((this.contextEpochs.get(frame.contextId) ?? 0) === epoch) {
          this.cachedProbs.set(frame.contextId, probs);
          if (this.initialized) {
            this.acousticSignalSink?.({
              contextId: frame.contextId,
              timestampMs: frame.timestampMs,
              signal: "prosody",
              payload: {
                channel: frame.channel,
                pShift: probs.pShift,
                pBackchannel: probs.pBackchannel,
                pHold: probs.pHold,
              },
            });
          }
        }
      });
    const settled = next.catch(() => undefined).finally(() => {
      if (this.inferenceChains.get(frame.contextId) === settled) {
        this.inferenceChains.delete(frame.contextId);
        this.contextEpochs.delete(frame.contextId);
      }
    });
    this.inferenceChains.set(frame.contextId, settled);
  }
}
