// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Silero VAD Plugin
//
// Runs the Silero ONNX model locally and emits VAD packets through PipelineBus.
// The model/state handling follows Pipecat's Silero analyzer and RapidAI's
// session-owned detector pattern: one model instance per session, state reset on
// lifecycle close, and 16 kHz LINEAR16 mono as the internal audio format.

import { fileURLToPath } from "node:url";

import type { PipelineBus } from "@asyncdot/voice";
import {
  ErrorCategory,
  Route,
  type PluginConfig,
  type VadSpeechActivityPacket,
  type VadSpeechEndedPacket,
  type VadSpeechStartedPacket,
  type VoiceErrorPacket,
  type VoicePlugin,
  isRecoverable,
  optionalStringConfig,
} from "@asyncdot/voice";
import { pcm16BytesToSamples } from "@asyncdot/voice/audio";

type Ort = typeof import("onnxruntime-node");
type InferenceSession = import("onnxruntime-node").InferenceSession;

const DEFAULT_MODEL_PATH = fileURLToPath(new URL("../models/silero_vad.onnx", import.meta.url));
const DEFAULT_SAMPLE_RATE = 16000;
const WINDOW_SAMPLES_16K = 512;
const CONTEXT_SAMPLES_16K = 64;

type VadState = "quiet" | "starting" | "speaking" | "stopping";

export class SileroVADPlugin implements VoicePlugin {
  private bus: PipelineBus | null = null;
  private session: InferenceSession | null = null;
  private ort: Ort | null = null;
  private state = new Float32Array(2 * 1 * 128);
  private context = new Float32Array(CONTEXT_SAMPLES_16K);
  private pendingSamples: number[] = [];
  private vadState: VadState = "quiet";
  private speechFrames = 0;
  private confidenceThreshold = 0.5;
  private minSilenceDurationMs = 200;
  private speechPadMs = 80;
  private speechStartDurationMs = 32;
  private sampleRate = DEFAULT_SAMPLE_RATE;
  private silenceFrames = 0;
  private lastResetMs = 0;
  private disposers: Array<() => void> = [];

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    this.confidenceThreshold = readNumber(config, "threshold", 0.5);
    this.minSilenceDurationMs = readNumber(config, "min_silence_duration_ms", 200);
    this.speechPadMs = readNumber(config, "speech_pad_ms", 80);
    this.speechStartDurationMs = readNumber(config, "speech_start_duration_ms", 32);
    this.sampleRate = readNumber(config, "sample_rate", DEFAULT_SAMPLE_RATE);
    if (this.sampleRate !== 16000) {
      throw new Error(`SileroVADPlugin requires 16 kHz PCM input, got ${String(this.sampleRate)} Hz`);
    }

    const modelPath = optionalStringConfig(config, "model_path") ?? DEFAULT_MODEL_PATH;
    this.ort = await import("onnxruntime-node");
    this.session = await this.ort.InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
      interOpNumThreads: 1,
      intraOpNumThreads: 1,
    });
    this.resetModelState();

    this.disposers.push(
      bus.on("vad.audio", async (pkt: unknown) => {
        const audioPkt = pkt as { audio: Uint8Array; contextId: string };
        await this.processAudio(audioPkt.audio, audioPkt.contextId);
      }),
    );
  }

  async processAudio(audio: Uint8Array, contextId: string): Promise<void> {
    if (!this.bus || !this.session || !this.ort) return;
    if (audio.byteLength % 2 !== 0) {
      this.emitError(contextId, new Error("VAD audio must be 16-bit PCM with even byte length"));
      return;
    }

    // Offset-safe: inbound PCM is often a Uint8Array view into a pooled Node
    // Buffer at an ODD byteOffset, so `new Int16Array(buffer, byteOffset, …)`
    // throws "start offset of Int16Array should be a multiple of 2". The canonical
    // helper reads via DataView and is offset-agnostic.
    const samples = pcm16BytesToSamples(audio);
    for (let i = 0; i < samples.length; i += 1) {
      this.pendingSamples.push(samples[i]! / 32768);
    }

    while (this.pendingSamples.length >= WINDOW_SAMPLES_16K) {
      const window = new Float32Array(WINDOW_SAMPLES_16K);
      for (let i = 0; i < WINDOW_SAMPLES_16K; i += 1) {
        window[i] = this.pendingSamples.shift()!;
      }
      const confidence = await this.runModel(window, contextId);
      this.emitVadState(confidence, contextId);
    }
  }

  async close(): Promise<void> {
    for (const dispose of this.disposers.splice(0)) dispose();
    this.bus = null;
    this.session = null;
    this.ort = null;
    this.pendingSamples = [];
    this.resetModelState();
  }

  private async runModel(window: Float32Array, contextId: string): Promise<number> {
    if (!this.session || !this.ort) return 0;

    const input = new Float32Array(CONTEXT_SAMPLES_16K + WINDOW_SAMPLES_16K);
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

      const now = Date.now();
      if (this.vadState === "quiet" && now - this.lastResetMs >= 5000) {
        this.resetModelState();
      }

      return typeof probability === "number" ? probability : 0;
    } catch (err) {
      this.emitError(contextId, err instanceof Error ? err : new Error(String(err)));
      return 0;
    }
  }

  private emitVadState(confidence: number, contextId: string): void {
    if (!this.bus) return;

    const now = Date.now();
    const isSpeech = confidence >= this.confidenceThreshold;
    const silenceFrameTarget = Math.max(1, Math.ceil(this.minSilenceDurationMs / 32));

    switch (this.vadState) {
      case "quiet":
        if (isSpeech) {
          this.vadState = "starting";
          this.speechFrames = 1;
          this.promoteStartingToSpeakingIfReady(confidence, contextId, now);
        }
        break;

      case "starting":
        if (isSpeech) {
          if (!this.promoteStartingToSpeakingIfReady(confidence, contextId, now)) {
            this.speechFrames += 1;
            this.promoteStartingToSpeakingIfReady(confidence, contextId, now);
          }
        } else {
          this.vadState = "quiet";
          this.speechFrames = 0;
        }
        break;

      case "speaking":
        if (isSpeech) {
          this.emitSpeechActivity(contextId, now);
        } else {
          this.vadState = "stopping";
          this.silenceFrames = 1;
        }
        break;

      case "stopping":
        if (isSpeech) {
          this.vadState = "speaking";
          this.silenceFrames = 0;
          this.emitSpeechActivity(contextId, now);
        } else {
          this.silenceFrames += 1;
          if (this.silenceFrames * 32 < this.minSilenceDurationMs + this.speechPadMs) break;
          if (this.silenceFrames < silenceFrameTarget) break;

          const hangoverMs = this.silenceFrames * 32;
          this.vadState = "quiet";
          this.silenceFrames = 0;
          this.speechFrames = 0;
          const ended: VadSpeechEndedPacket = {
            kind: "vad.speech_ended",
            contextId,
            timestampMs: now,
          };
          this.bus.push(Route.Main, ended);
          this.bus.push(Route.Main, {
            kind: "metric.conversation",
            contextId,
            timestampMs: now,
            name: "vad.stop_hangover_ms",
            value: String(hangoverMs),
          });
        }
        break;
    }
  }

  private promoteStartingToSpeakingIfReady(
    confidence: number,
    contextId: string,
    now: number,
  ): boolean {
    if (!this.bus || this.vadState !== "starting") return false;
    if (this.speechFrames * 32 < this.speechStartDurationMs) return false;

    const startDelayMs = this.speechFrames * 32;
    this.vadState = "speaking";
    this.speechFrames = 0;
    const started: VadSpeechStartedPacket = {
      kind: "vad.speech_started",
      contextId,
      timestampMs: now,
      confidence,
    };
    this.bus.push(Route.Main, started);
    this.bus.push(Route.Main, {
      kind: "metric.conversation",
      contextId,
      timestampMs: now,
      name: "vad.start_delay_ms",
      value: String(startDelayMs),
    });
    this.emitSpeechActivity(contextId, now);
    return true;
  }

  private emitSpeechActivity(contextId: string, now: number): void {
    if (!this.bus) return;
    const activity: VadSpeechActivityPacket = {
      kind: "vad.speech_activity",
      contextId,
      timestampMs: now,
      isAsync: true,
    };
    this.bus.push(Route.Main, activity);
  }

  private resetModelState(): void {
    this.state = new Float32Array(2 * 1 * 128);
    this.context = new Float32Array(CONTEXT_SAMPLES_16K);
    this.lastResetMs = Date.now();
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

function readNumber(config: PluginConfig, key: string, fallback: number): number {
  const value = config[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
