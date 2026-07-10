// SPDX-License-Identifier: MIT

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { StreamingPcm16Resampler, optionalStringConfig, type PluginConfig } from "@kuralle-syrinx/core";
import {
  ZERO_VAP_PROBS,
  type VapPredictor,
  type VapPredictorFrame,
  type VapProbs,
} from "./vap-policy.js";

type Ort = typeof import("onnxruntime-node");
type InferenceSession = import("onnxruntime-node").InferenceSession;
type Tensor = import("onnxruntime-node").Tensor;

const DEFAULT_BUNDLE_PATH = fileURLToPath(new URL("../models/dualturn", import.meta.url));
const MODEL_SAMPLE_RATE_HZ = 24_000;
const MODEL_WINDOW_SAMPLES = 1_920;
const QUEUE_CAPACITY_SAMPLES = MODEL_SAMPLE_RATE_HZ * 2;

interface DualTurnManifest {
  readonly format: "syrinx.dualturn.onnx.v1";
  readonly context_frames: number;
  readonly files: {
    readonly mimi_model: string;
    readonly mimi_metadata: string;
    readonly projection: string;
    readonly backbone: string;
    readonly heads: string;
  };
}

interface MimiMetadata {
  readonly cache_position_len: number;
  readonly max_past_len: number;
  readonly contract: {
    readonly spec: {
      readonly padding_cache_shapes: readonly (readonly number[])[];
      readonly past_key_value_shapes: readonly (readonly number[])[];
    };
  };
}

interface MimiStreamState {
  cachePosition: number;
  position: number;
  states: Tensor[];
}

interface DualTurnContext {
  readonly queues: Record<VapPredictorFrame["channel"], PcmSampleQueue>;
  readonly resamplers: Map<string, StreamingPcm16Resampler>;
  readonly mimi: Record<VapPredictorFrame["channel"], MimiStreamState>;
  backbonePast: Tensor[];
  backbonePosition: number;
  probs: VapProbs;
}

export class LocalVapPredictor implements VapPredictor {
  private ort: Ort | null = null;
  private mimiSession: InferenceSession | null = null;
  private projectionSession: InferenceSession | null = null;
  private backboneSession: InferenceSession | null = null;
  private headsSession: InferenceSession | null = null;
  private manifest: DualTurnManifest | null = null;
  private mimiMetadata: MimiMetadata | null = null;
  private readonly contexts = new Map<string, DualTurnContext>();

  async initialize(cfg: PluginConfig = {}): Promise<void> {
    const bundlePath = optionalStringConfig(cfg, "bundle_path")
      ?? optionalStringConfig(cfg, "model_path")
      ?? DEFAULT_BUNDLE_PATH;
    const manifest = parseManifest(await readJson(join(bundlePath, "manifest.json")));
    const mimiMetadata = parseMimiMetadata(
      await readJson(join(bundlePath, manifest.files.mimi_metadata)),
    );
    const ort = await import("onnxruntime-node");
    const options = {
      executionProviders: ["cpu"] as const,
      interOpNumThreads: 1,
      intraOpNumThreads: 1,
    };
    const [mimiSession, projectionSession, backboneSession, headsSession] = await Promise.all([
      ort.InferenceSession.create(join(bundlePath, manifest.files.mimi_model), options),
      ort.InferenceSession.create(join(bundlePath, manifest.files.projection), options),
      ort.InferenceSession.create(join(bundlePath, manifest.files.backbone), options),
      ort.InferenceSession.create(join(bundlePath, manifest.files.heads), options),
    ]);
    this.ort = ort;
    this.manifest = manifest;
    this.mimiMetadata = mimiMetadata;
    this.mimiSession = mimiSession;
    this.projectionSession = projectionSession;
    this.backboneSession = backboneSession;
    this.headsSession = headsSession;
  }

  async push(frame: VapPredictorFrame): Promise<VapProbs> {
    this.assertInitialized();
    const context = this.contextFor(frame.contextId);
    const resampled = this.resample(context, frame);
    context.queues[frame.channel].append(resampled);

    while (this.hasReadyWindow(context)) {
      const user = context.queues.user.length >= MODEL_WINDOW_SAMPLES
        ? context.queues.user.drainNormalized(MODEL_WINDOW_SAMPLES)
        : new Float32Array(MODEL_WINDOW_SAMPLES);
      const assistant = context.queues.assistant.length >= MODEL_WINDOW_SAMPLES
        ? context.queues.assistant.drainNormalized(MODEL_WINDOW_SAMPLES)
        : new Float32Array(MODEL_WINDOW_SAMPLES);
      context.probs = await this.inferWindow(context, user, assistant);
    }
    return context.probs;
  }

  reset(contextId: string): void {
    this.contexts.delete(contextId);
  }

  async close(): Promise<void> {
    this.contexts.clear();
    this.mimiSession = null;
    this.projectionSession = null;
    this.backboneSession = null;
    this.headsSession = null;
    this.mimiMetadata = null;
    this.manifest = null;
    this.ort = null;
  }

  private contextFor(contextId: string): DualTurnContext {
    let context = this.contexts.get(contextId);
    if (!context) {
      context = {
        queues: {
          user: new PcmSampleQueue(QUEUE_CAPACITY_SAMPLES),
          assistant: new PcmSampleQueue(QUEUE_CAPACITY_SAMPLES),
        },
        resamplers: new Map(),
        mimi: {
          user: this.newMimiState(),
          assistant: this.newMimiState(),
        },
        backbonePast: [],
        backbonePosition: 0,
        probs: ZERO_VAP_PROBS,
      };
      this.contexts.set(contextId, context);
    }
    return context;
  }

  private newMimiState(): MimiStreamState {
    const ort = this.requireOrt();
    const metadata = this.requireMimiMetadata();
    const shapes = [
      ...metadata.contract.spec.padding_cache_shapes,
      ...metadata.contract.spec.past_key_value_shapes,
    ];
    return {
      cachePosition: 0,
      position: 0,
      states: shapes.map((shape) => new ort.Tensor(
        "float32",
        new Float32Array(product(shape)),
        [...shape],
      )),
    };
  }

  private resample(context: DualTurnContext, frame: VapPredictorFrame): Int16Array {
    if (frame.sampleRateHz === MODEL_SAMPLE_RATE_HZ) return frame.audio;
    const key = `${frame.channel}:${String(frame.sampleRateHz)}`;
    let resampler = context.resamplers.get(key);
    if (!resampler) {
      resampler = new StreamingPcm16Resampler(frame.sampleRateHz, MODEL_SAMPLE_RATE_HZ);
      context.resamplers.set(key, resampler);
    }
    return resampler.process(frame.audio);
  }

  private hasReadyWindow(context: DualTurnContext): boolean {
    const userWindows = Math.floor(context.queues.user.length / MODEL_WINDOW_SAMPLES);
    const assistantWindows = Math.floor(context.queues.assistant.length / MODEL_WINDOW_SAMPLES);
    return (userWindows > 0 && assistantWindows > 0) || userWindows > 1 || assistantWindows > 1;
  }

  private async inferWindow(
    context: DualTurnContext,
    userAudio: Float32Array,
    assistantAudio: Float32Array,
  ): Promise<VapProbs> {
    const [userFeatures, assistantFeatures] = await Promise.all([
      this.encodeMimi(userAudio, context.mimi.user),
      this.encodeMimi(assistantAudio, context.mimi.assistant),
    ]);
    const projection = await this.requireSession(this.projectionSession, "projection").run({
      user_features: userFeatures,
      assistant_features: assistantFeatures,
    });
    const inputsEmbeds = requireTensor(projection["inputs_embeds"], "inputs_embeds");
    const hiddenStates = await this.runBackbone(context, inputsEmbeds);
    const outputs = await this.requireSession(this.headsSession, "turn heads").run({
      hidden_states: hiddenStates,
    });
    return mapTurnHeads(outputs);
  }

  private async encodeMimi(audio: Float32Array, state: MimiStreamState): Promise<Tensor> {
    const ort = this.requireOrt();
    const metadata = this.requireMimiMetadata();
    const cpLength = metadata.cache_position_len;
    const cachePosition = new BigInt64Array(cpLength);
    const positionIds = new BigInt64Array(cpLength);
    for (let index = 0; index < cpLength; index += 1) {
      cachePosition[index] = BigInt((state.cachePosition + index) % metadata.max_past_len);
      positionIds[index] = BigInt(state.position + index);
    }
    const feeds: Record<string, Tensor> = {
      wave_24k: new ort.Tensor("float32", audio, [1, 1, MODEL_WINDOW_SAMPLES]),
      cache_position: new ort.Tensor("int64", cachePosition, [cpLength]),
      position_ids: new ort.Tensor("int64", positionIds, [cpLength]),
    };
    const paddingCount = metadata.contract.spec.padding_cache_shapes.length;
    for (let index = 0; index < state.states.length; index += 1) {
      const name = index < paddingCount
        ? `pad_cache_${String(index)}`
        : `past_${String(index - paddingCount)}`;
      feeds[name] = state.states[index]!;
    }
    const output = await this.requireSession(this.mimiSession, "Mimi").run(feeds);
    const cpOut = requireTensor(output["cache_position_out"], "cache_position_out");
    const lastCachePosition = readLastInteger(cpOut);
    state.cachePosition = lastCachePosition ?? ((state.cachePosition + cpLength) % metadata.max_past_len);
    state.position += cpLength;
    state.states = [
      ...Array.from({ length: paddingCount }, (_, index) =>
        requireTensor(output[`pad_cache_out_${String(index)}`], `pad_cache_out_${String(index)}`)),
      ...Array.from({ length: metadata.contract.spec.past_key_value_shapes.length }, (_, index) =>
        requireTensor(output[`past_out_${String(index)}`], `past_out_${String(index)}`)),
    ];
    return normalizeMimiFeatures(requireTensor(output["embeddings"], "embeddings"), ort);
  }

  private async runBackbone(context: DualTurnContext, inputsEmbeds: Tensor): Promise<Tensor> {
    const ort = this.requireOrt();
    const session = this.requireSession(this.backboneSession, "backbone");
    const timeSteps = inputsEmbeds.dims[1] ?? 0;
    const pastLength = context.backbonePast[0]?.dims[2] ?? 0;
    const feeds: Record<string, Tensor> = {
      inputs_embeds: inputsEmbeds,
      attention_mask: new ort.Tensor(
        "int64",
        filledBigInt(pastLength + timeSteps, 1n),
        [1, pastLength + timeSteps],
      ),
      position_ids: new ort.Tensor(
        "int64",
        rangeBigInt(context.backbonePosition, timeSteps),
        [1, timeSteps],
      ),
    };
    for (let layer = 0; layer < 24; layer += 1) {
      const key = context.backbonePast[layer * 2]
        ?? new ort.Tensor("float32", new Float32Array(0), [1, 2, 0, 64]);
      const value = context.backbonePast[layer * 2 + 1]
        ?? new ort.Tensor("float32", new Float32Array(0), [1, 2, 0, 64]);
      feeds[`past_key_values.${String(layer)}.key`] = key;
      feeds[`past_key_values.${String(layer)}.value`] = value;
    }
    const outputs = await session.run(feeds);
    const hidden = requireTensor(outputs[session.outputNames[0]!], "backbone hidden states");
    context.backbonePast = session.outputNames.slice(1).map((name) =>
      trimQwenCache(requireTensor(outputs[name], name), this.requireManifest().context_frames, ort),
    );
    context.backbonePosition += timeSteps;
    return hidden;
  }

  private assertInitialized(): void {
    this.requireOrt();
    this.requireManifest();
    this.requireMimiMetadata();
    this.requireSession(this.mimiSession, "Mimi");
    this.requireSession(this.projectionSession, "projection");
    this.requireSession(this.backboneSession, "backbone");
    this.requireSession(this.headsSession, "turn heads");
  }

  private requireOrt(): Ort {
    if (!this.ort) throw new Error("LocalVapPredictor is not initialized");
    return this.ort;
  }

  private requireManifest(): DualTurnManifest {
    if (!this.manifest) throw new Error("LocalVapPredictor bundle manifest is not loaded");
    return this.manifest;
  }

  private requireMimiMetadata(): MimiMetadata {
    if (!this.mimiMetadata) throw new Error("LocalVapPredictor Mimi metadata is not loaded");
    return this.mimiMetadata;
  }

  private requireSession(session: InferenceSession | null, label: string): InferenceSession {
    if (!session) throw new Error(`LocalVapPredictor ${label} session is not loaded`);
    return session;
  }
}

class PcmSampleQueue {
  private readonly storage: Int16Array;
  private readIndex = 0;
  private writeIndex = 0;
  private sampleCount = 0;

  constructor(capacity: number) {
    this.storage = new Int16Array(capacity);
  }

  get length(): number {
    return this.sampleCount;
  }

  append(audio: Int16Array): void {
    if (audio.length > this.storage.length - this.sampleCount) {
      throw new Error("DualTurn audio queue overflowed while inference was backlogged");
    }
    for (const sample of audio) {
      this.storage[this.writeIndex] = sample;
      this.writeIndex = (this.writeIndex + 1) % this.storage.length;
      this.sampleCount += 1;
    }
  }

  drainNormalized(count: number): Float32Array {
    if (count > this.sampleCount) throw new Error("DualTurn audio queue underflow");
    const output = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      output[index] = this.storage[this.readIndex]! / 32_768;
      this.readIndex = (this.readIndex + 1) % this.storage.length;
      this.sampleCount -= 1;
    }
    return output;
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function parseManifest(value: unknown): DualTurnManifest {
  const manifest = value as Partial<DualTurnManifest>;
  if (manifest.format !== "syrinx.dualturn.onnx.v1" || !manifest.files || !manifest.context_frames) {
    throw new Error("Unsupported or invalid DualTurn bundle manifest");
  }
  return manifest as DualTurnManifest;
}

function parseMimiMetadata(value: unknown): MimiMetadata {
  const metadata = value as Partial<MimiMetadata>;
  if (!metadata.cache_position_len || !metadata.max_past_len || !metadata.contract?.spec) {
    throw new Error("Invalid Continuous Mimi ONNX metadata");
  }
  return metadata as MimiMetadata;
}

function product(shape: readonly number[]): number {
  return shape.reduce((size, dimension) => size * dimension, 1);
}

function requireTensor(tensor: Tensor | undefined, name: string): Tensor {
  if (!tensor) throw new Error(`ONNX output ${name} is missing`);
  return tensor;
}

function readLastInteger(tensor: Tensor): number | undefined {
  const data = tensor.data;
  const value = data[data.length - 1];
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  return undefined;
}

function normalizeMimiFeatures(tensor: Tensor, ort: Ort): Tensor {
  const [batch = 0, first = 0, second = 0] = tensor.dims;
  if (batch !== 1) throw new Error(`Mimi emitted unsupported batch size ${String(batch)}`);
  if (second === 512) return tensor;
  if (first !== 512) {
    throw new Error(`Mimi emitted unsupported feature shape [${tensor.dims.join(",")}]`);
  }
  const source = tensor.data as Float32Array;
  const output = new Float32Array(second * first);
  for (let frame = 0; frame < second; frame += 1) {
    for (let feature = 0; feature < first; feature += 1) {
      output[frame * first + feature] = source[feature * second + frame]!;
    }
  }
  return new ort.Tensor("float32", output, [1, second, first]);
}

function rangeBigInt(start: number, length: number): BigInt64Array {
  const output = new BigInt64Array(length);
  for (let index = 0; index < length; index += 1) output[index] = BigInt(start + index);
  return output;
}

function filledBigInt(length: number, value: bigint): BigInt64Array {
  const output = new BigInt64Array(length);
  output.fill(value);
  return output;
}

function trimQwenCache(tensor: Tensor, maxFrames: number, ort: Ort): Tensor {
  const [batch = 0, heads = 0, frames = 0, headSize = 0] = tensor.dims;
  if (frames <= maxFrames) return tensor;
  if (batch !== 1) throw new Error("DualTurn Qwen cache only supports batch size 1");
  const source = tensor.data as Float32Array;
  const output = new Float32Array(heads * maxFrames * headSize);
  for (let head = 0; head < heads; head += 1) {
    const sourceStart = (head * frames + frames - maxFrames) * headSize;
    const destinationStart = head * maxFrames * headSize;
    output.set(source.subarray(sourceStart, sourceStart + maxFrames * headSize), destinationStart);
  }
  return new ort.Tensor("float32", output, [1, heads, maxFrames, headSize]);
}

function mapTurnHeads(output: Record<string, Tensor>): VapProbs {
  const eot = requireFloatOutput(output["eot_probs"], "eot_probs");
  const bot = requireFloatOutput(output["bot_probs"], "bot_probs");
  const hold = requireFloatOutput(output["hold_probs"], "hold_probs");
  const backchannel = requireFloatOutput(output["bc_probs"], "bc_probs");
  const latestUserIndex = eot.length - 2;
  return {
    pShift: Math.max(eot[latestUserIndex] ?? 0, bot[latestUserIndex] ?? 0),
    pBackchannel: backchannel[backchannel.length - 2] ?? 0,
    pHold: hold[hold.length - 2] ?? 0,
  };
}

function requireFloatOutput(tensor: Tensor | undefined, name: string): Float32Array {
  const value = requireTensor(tensor, name).data;
  if (!(value instanceof Float32Array)) throw new Error(`ONNX output ${name} must be float32`);
  return value;
}
