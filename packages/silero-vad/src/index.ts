// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Silero VAD Plugin (Node, onnxruntime-node)
//
// Runs the Silero ONNX model locally and emits VAD packets through PipelineBus.
// All turn/state decisions live in the shared SileroVadStateMachine
// (vad-state-machine.ts) — this file only owns the Node-specific ONNX runtime
// and on-disk model loading. The Workers variant (workers.ts) shares the same
// machine with onnxruntime-web, so the two can never drift again.

import { fileURLToPath } from "node:url";

import type { PipelineBus } from "@kuralle-syrinx/core";
import {
  ErrorCategory,
  Route,
  type PluginConfig,
  type VoiceErrorPacket,
  type VoicePlugin,
  isRecoverable,
  optionalStringConfig,
} from "@kuralle-syrinx/core";
import {
  CONTEXT_SAMPLES_16K,
  Pcm16WindowBuffer,
  SileroVadStateMachine,
  readVadTuning,
} from "./vad-state-machine.js";

type Ort = typeof import("onnxruntime-node");
type InferenceSession = import("onnxruntime-node").InferenceSession;

const DEFAULT_MODEL_PATH = fileURLToPath(new URL("../models/silero_vad.onnx", import.meta.url));
const DEFAULT_SAMPLE_RATE = 16000;

export class SileroVADPlugin implements VoicePlugin {
  private bus: PipelineBus | null = null;
  private session: InferenceSession | null = null;
  private ort: Ort | null = null;
  private state = new Float32Array(2 * 1 * 128);
  private context = new Float32Array(CONTEXT_SAMPLES_16K);
  private readonly windows = new Pcm16WindowBuffer();
  private machine: SileroVadStateMachine | null = null;
  private sampleRate = DEFAULT_SAMPLE_RATE;
  private disposers: Array<() => void> = [];

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    this.sampleRate = readSampleRate(config);
    this.machine = new SileroVadStateMachine(bus, readVadTuning(config), () => this.resetModelState());

    const modelPath = optionalStringConfig(config, "model_path") ?? DEFAULT_MODEL_PATH;
    this.ort = await import("onnxruntime-node");
    this.session = await this.ort.InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
      interOpNumThreads: 1,
      intraOpNumThreads: 1,
    });
    this.resetModelState();
    this.machine.noteModelReset();

    this.disposers.push(
      bus.on("vad.audio", async (pkt: unknown) => {
        const audioPkt = pkt as { audio: Uint8Array; contextId: string };
        await this.processAudio(audioPkt.audio, audioPkt.contextId);
      }),
    );
  }

  async processAudio(audio: Uint8Array, contextId: string): Promise<void> {
    if (!this.bus || !this.session || !this.ort || !this.machine) return;
    if (audio.byteLength % 2 !== 0) {
      this.emitError(contextId, new Error("VAD audio must be 16-bit PCM with even byte length"));
      return;
    }

    // Offset-safe: inbound PCM is often a Uint8Array view into a pooled Node
    // Buffer at an ODD byteOffset — the shared buffer reads via DataView.
    this.windows.push(audio);
    for (let window = this.windows.next(); window; window = this.windows.next()) {
      const confidence = await this.runModel(window, contextId);
      this.machine.observe(confidence, contextId);
    }
  }

  async close(): Promise<void> {
    for (const dispose of this.disposers.splice(0)) dispose();
    this.bus = null;
    this.session = null;
    this.ort = null;
    this.windows.clear();
    this.resetModelState();
  }

  private async runModel(window: Float32Array, contextId: string): Promise<number> {
    if (!this.session || !this.ort) return 0;

    const input = new Float32Array(CONTEXT_SAMPLES_16K + window.length);
    input.set(this.context, 0);
    input.set(window, CONTEXT_SAMPLES_16K);

    try {
      const output = await this.session.run({
        input: new this.ort.Tensor("float32", input, [1, input.length]),
        state: new this.ort.Tensor("float32", this.state, [2, 1, 128]),
        sr: new this.ort.Tensor("int64", BigInt64Array.from([BigInt(this.sampleRate)]), []),
      });

      const probability = output["output"]?.data?.[0];
      const nextState = output["stateN"]?.data;
      if (nextState instanceof Float32Array) {
        this.state = new Float32Array(nextState);
      }
      this.context = input.slice(-CONTEXT_SAMPLES_16K);

      return typeof probability === "number" ? probability : 0;
    } catch (err) {
      this.emitError(contextId, err instanceof Error ? err : new Error(String(err)));
      return 0;
    }
  }

  private resetModelState(): void {
    this.state = new Float32Array(2 * 1 * 128);
    this.context = new Float32Array(CONTEXT_SAMPLES_16K);
  }

  private emitError(contextId: string, err: Error): void {
    const packet: VoiceErrorPacket = {
      kind: "vad.error",
      contextId,
      timestampMs: Date.now(),
      component: "vad",
      category: ErrorCategory.InvalidInput,
      cause: err,
      isRecoverable: isRecoverable(ErrorCategory.InvalidInput),
    };
    this.bus?.push(Route.Critical, packet);
  }
}

function readSampleRate(config: PluginConfig): number {
  const value = config["sample_rate"];
  const sampleRate = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_SAMPLE_RATE;
  if (sampleRate !== 16000) {
    throw new Error(`SileroVADPlugin requires 16 kHz PCM input, got ${String(sampleRate)} Hz`);
  }
  return sampleRate;
}
