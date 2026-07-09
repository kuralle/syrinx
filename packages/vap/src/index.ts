// SPDX-License-Identifier: MIT

import { fileURLToPath } from "node:url";

import type { PluginConfig } from "@kuralle-syrinx/core";
import { optionalStringConfig } from "@kuralle-syrinx/core";
import type { InteractionDecision, InteractionObservation, InteractionPolicy } from "@kuralle-syrinx/core";
import {
  DEFAULT_VAP_THRESHOLDS,
  RollingFeatureBuffer,
  ZERO_VAP_PROBS,
  decideFromProbs,
  type VapDecisionContext,
  type VapPredictor,
  type VapProbs,
  type VapThresholds,
} from "./vap-policy.js";

export type { VapPredictor, VapProbs, VapThresholds, VapDecisionContext } from "./vap-policy.js";
export {
  DEFAULT_VAP_THRESHOLDS,
  ZERO_VAP_PROBS,
  decideFromProbs,
  RollingFeatureBuffer,
} from "./vap-policy.js";

type Ort = typeof import("onnxruntime-node");
type InferenceSession = import("onnxruntime-node").InferenceSession;

const DEFAULT_MODEL_PATH = fileURLToPath(new URL("../models/vap.onnx", import.meta.url));

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

  async predict(_features: Float32Array): Promise<VapProbs> {
    return this.scripted.shift() ?? this.fallback;
  }

  async close(): Promise<void> {}
}

export class LocalVapPredictor implements VapPredictor {
  private ort: Ort | null = null;
  private session: InferenceSession | null = null;

  async initialize(cfg: PluginConfig = {}): Promise<void> {
    const modelPath = optionalStringConfig(cfg, "model_path") ?? DEFAULT_MODEL_PATH;
    this.ort = await import("onnxruntime-node");
    this.session = await this.ort.InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
      interOpNumThreads: 1,
      intraOpNumThreads: 1,
    });
  }

  async predict(features: Float32Array): Promise<VapProbs> {
    if (!this.session || !this.ort) {
      throw new Error("LocalVapPredictor is not initialized");
    }
    const output = await this.session.run({
      features: new this.ort.Tensor("float32", features, [1, features.length]),
    });
    return mapOnnxOutput(output);
  }

  async close(): Promise<void> {
    this.session = null;
    this.ort = null;
  }
}

export interface VapInteractionPolicyDeps {
  readonly predictor: VapPredictor;
  readonly thresholds?: VapThresholds;
  readonly maxFeatureSamples?: number;
}

export class VapInteractionPolicy implements InteractionPolicy {
  private readonly predictor: VapPredictor;
  private readonly thresholds: VapThresholds;
  private readonly maxFeatureSamples: number;
  private readonly buffers = new Map<string, RollingFeatureBuffer>();
  private readonly cachedProbs = new Map<string, VapProbs>();
  private readonly inferenceInFlight = new Set<string>();
  private ttsActive = false;
  private ttsContextId = "";
  private delegateInFlight = false;
  private initialized = false;

  constructor(deps: VapInteractionPolicyDeps) {
    this.predictor = deps.predictor;
    this.thresholds = deps.thresholds ?? DEFAULT_VAP_THRESHOLDS;
    this.maxFeatureSamples = deps.maxFeatureSamples ?? 16_000;
  }

  async initialize(cfg: PluginConfig = {}): Promise<void> {
    await this.predictor.initialize(cfg);
    this.initialized = true;
  }

  observe(obs: InteractionObservation): readonly InteractionDecision[] {
    switch (obs.kind) {
      case "playout_tick":
        this.ttsActive = obs.ttsActive === true;
        if (this.ttsActive) this.ttsContextId = obs.contextId;
        return [];
      case "delegate_state":
        this.delegateInFlight = obs.delegateInFlight === true;
        return [];
      case "audio_frame":
        return this.observeAudioFrame(obs);
      default:
        return [];
    }
  }

  reset(contextId: string): void {
    this.buffers.get(contextId)?.reset();
    this.buffers.delete(contextId);
    this.cachedProbs.delete(contextId);
    this.inferenceInFlight.delete(contextId);
  }

  async close(): Promise<void> {
    await this.predictor.close();
    this.buffers.clear();
    this.cachedProbs.clear();
    this.inferenceInFlight.clear();
    this.initialized = false;
  }

  private observeAudioFrame(
    obs: Extract<InteractionObservation, { kind: "audio_frame" }>,
  ): readonly InteractionDecision[] {
    if (!this.initialized) return [{ kind: "keep_listening" }];
    const buffer = this.bufferFor(obs.contextId);
    const features = buffer.append(obs.audio);
    this.kickInference(obs.contextId, features);
    const probs = this.cachedProbs.get(obs.contextId) ?? ZERO_VAP_PROBS;
    return decideFromProbs(probs, this.decisionContext());
  }

  private decisionContext(): VapDecisionContext {
    return {
      ttsActive: this.ttsActive,
      ttsContextId: this.ttsContextId,
      delegateInFlight: this.delegateInFlight,
    };
  }

  private bufferFor(contextId: string): RollingFeatureBuffer {
    let buffer = this.buffers.get(contextId);
    if (!buffer) {
      buffer = new RollingFeatureBuffer(this.maxFeatureSamples);
      this.buffers.set(contextId, buffer);
    }
    return buffer;
  }

  private kickInference(contextId: string, features: Float32Array): void {
    if (this.inferenceInFlight.has(contextId)) return;
    this.inferenceInFlight.add(contextId);
    void this.predictor
      .predict(features)
      .then((probs) => {
        this.cachedProbs.set(contextId, probs);
      })
      .finally(() => {
        this.inferenceInFlight.delete(contextId);
      });
  }
}

function mapOnnxOutput(output: Record<string, import("onnxruntime-node").Tensor>): VapProbs {
  const shift = readScalar(output["p_shift"] ?? output["pShift"] ?? output["shift"]);
  const backchannel = readScalar(output["p_backchannel"] ?? output["pBackchannel"] ?? output["backchannel"]);
  const hold = readScalar(output["p_hold"] ?? output["pHold"] ?? output["hold"]);
  return { pShift: shift, pBackchannel: backchannel, pHold: hold };
}

function readScalar(tensor: import("onnxruntime-node").Tensor | undefined): number {
  const value = tensor?.data?.[0];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}