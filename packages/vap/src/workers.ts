// SPDX-License-Identifier: MIT

import type { PluginConfig } from "@kuralle-syrinx/core";
import { optionalStringConfig } from "@kuralle-syrinx/core";
import {
  RollingFeatureBuffer,
  ZERO_VAP_PROBS,
  type VapPredictor,
  type VapPredictorFrame,
  type VapProbs,
} from "./vap-policy.js";

type Ort = typeof import("onnxruntime-web");
type InferenceSession = import("onnxruntime-web").InferenceSession;

export class WorkersVapPredictor implements VapPredictor {
  private ort: Ort | null = null;
  private session: InferenceSession | null = null;

  async initialize(cfg: PluginConfig = {}): Promise<void> {
    this.ort = await import("onnxruntime-web");
    this.session = await this.ort.InferenceSession.create(await readModelBytes(cfg), {
      executionProviders: ["wasm"],
    });
  }

  private readonly buffers = new Map<string, RollingFeatureBuffer>();
  private readonly cachedProbs = new Map<string, VapProbs>();

  async push(frame: VapPredictorFrame): Promise<VapProbs> {
    if (!this.session || !this.ort) {
      throw new Error("WorkersVapPredictor is not initialized");
    }
    if (frame.channel === "assistant") {
      return this.cachedProbs.get(frame.contextId) ?? ZERO_VAP_PROBS;
    }
    const buffer = this.bufferFor(frame.contextId);
    buffer.append(frame.audio);
    const features = buffer.snapshot();
    const output = await this.session.run({
      features: new this.ort.Tensor("float32", features, [1, features.length]),
    });
    const probs = mapOnnxOutput(output);
    this.cachedProbs.set(frame.contextId, probs);
    return probs;
  }

  reset(contextId: string): void {
    this.buffers.delete(contextId);
    this.cachedProbs.delete(contextId);
  }

  async close(): Promise<void> {
    this.session = null;
    this.ort = null;
    this.buffers.clear();
    this.cachedProbs.clear();
  }

  private bufferFor(contextId: string): RollingFeatureBuffer {
    let buffer = this.buffers.get(contextId);
    if (!buffer) {
      buffer = new RollingFeatureBuffer();
      this.buffers.set(contextId, buffer);
    }
    return buffer;
  }
}

async function readModelBytes(cfg: PluginConfig): Promise<Uint8Array> {
  const bytes = cfg["model_bytes"];
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  const url = optionalStringConfig(cfg, "model_url");
  if (!url) {
    throw new Error("WorkersVapPredictor requires model_bytes or model_url");
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch VAP model from ${url}: ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function mapOnnxOutput(output: Record<string, import("onnxruntime-web").Tensor>): VapProbs {
  const shift = readScalar(output["p_shift"] ?? output["pShift"] ?? output["shift"]);
  const backchannel = readScalar(output["p_backchannel"] ?? output["pBackchannel"] ?? output["backchannel"]);
  const hold = readScalar(output["p_hold"] ?? output["pHold"] ?? output["hold"]);
  return { pShift: shift, pBackchannel: backchannel, pHold: hold };
}

function readScalar(tensor: import("onnxruntime-web").Tensor | undefined): number {
  const value = tensor?.data?.[0];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
