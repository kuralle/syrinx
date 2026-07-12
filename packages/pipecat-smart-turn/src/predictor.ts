// SPDX-License-Identifier: MIT

import { fileURLToPath } from "node:url";

import { optionalStringConfig, type PluginConfig } from "@kuralle-syrinx/core";
import type { SmartTurnPredictor } from "./smart-turn-types.js";

export type { SmartTurnPredictor } from "./smart-turn-types.js";

type Ort = typeof import("onnxruntime-node");
type InferenceSession = import("onnxruntime-node").InferenceSession;

interface FeatureExtractor {
  _extract_fbank_features(audio: Float32Array): Promise<{ data: unknown }>;
}

const SAMPLE_RATE = 16000;
const MAX_AUDIO_SAMPLES = SAMPLE_RATE * 8;
const DEFAULT_MODEL_PATH = fileURLToPath(new URL("../models/smart-turn-v3.2-cpu.onnx", import.meta.url));

export class LocalSmartTurnV3Predictor implements SmartTurnPredictor {
  private ort: Ort | null = null;
  private session: InferenceSession | null = null;
  private featureExtractor: FeatureExtractor | null = null;

  async initialize(config: PluginConfig): Promise<void> {
    const sampleRate = readNonNegativeNumber(config["sample_rate"], SAMPLE_RATE);
    if (sampleRate !== SAMPLE_RATE) {
      throw new Error(`Smart Turn requires 16 kHz PCM input, got ${String(sampleRate)} Hz`);
    }
    const modelPath = optionalStringConfig(config, "model_path") ?? DEFAULT_MODEL_PATH;
    const { WhisperFeatureExtractor } = await import("@huggingface/transformers");
    this.featureExtractor = new WhisperFeatureExtractor({
      feature_size: 80,
      sampling_rate: SAMPLE_RATE,
      hop_length: 160,
      n_fft: 400,
      n_samples: MAX_AUDIO_SAMPLES,
      nb_max_frames: 800,
    }) as FeatureExtractor;
    this.ort = await import("onnxruntime-node");
    this.session = await this.ort.InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
      interOpNumThreads: 1,
      intraOpNumThreads: 1,
    });
  }

  async predict(audio: Float32Array): Promise<number> {
    if (!this.ort || !this.session || !this.featureExtractor) {
      throw new Error("Smart Turn predictor is not initialized");
    }

    const modelAudio = new Float32Array(MAX_AUDIO_SAMPLES);
    const tail = audio.length > MAX_AUDIO_SAMPLES ? audio.slice(-MAX_AUDIO_SAMPLES) : audio;
    modelAudio.set(tail, MAX_AUDIO_SAMPLES - tail.length);
    const features = await this.featureExtractor._extract_fbank_features(modelAudio);
    const input = new this.ort.Tensor("float32", features.data as Float32Array, [1, 80, 800]);
    const outputs = await this.session.run({ input_features: input });
    const value = outputs["logits"]?.data[0];
    return typeof value === "number" ? value : 0;
  }

  async close(): Promise<void> {
    this.session = null;
    this.ort = null;
    this.featureExtractor = null;
  }
}

function readNonNegativeNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}
