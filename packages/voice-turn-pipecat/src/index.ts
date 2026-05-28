// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 - Pipecat Smart Turn Plugin
//
// Mirrors Pipecat's LocalSmartTurnAnalyzerV3 turn-stop strategy:
// Silero determines candidate speech boundaries, then Smart Turn v3 decides
// whether a pause is an actual completed user turn.

import { fileURLToPath } from "node:url";

import { WhisperFeatureExtractor } from "@huggingface/transformers";
import {
  Route,
  type EndOfSpeechPacket,
  type FinalizeSttPacket,
  type InterimEndOfSpeechPacket,
  type PipelineBus,
  type PluginConfig,
  type SttInterimPacket,
  type SttResultPacket,
  type VadAudioPacket,
  type VadSpeechEndedPacket,
  type VadSpeechStartedPacket,
  type VoicePlugin,
  optionalStringConfig,
} from "@asyncdot/voice";

type Ort = typeof import("onnxruntime-node");
type InferenceSession = import("onnxruntime-node").InferenceSession;

const SAMPLE_RATE = 16000;
const MAX_AUDIO_SAMPLES = SAMPLE_RATE * 8;
const DEFAULT_MODEL_PATH = fileURLToPath(new URL("../models/smart-turn-v3.2-cpu.onnx", import.meta.url));

interface TurnState {
  readonly contextId: string;
  audio: number[];
  finalPackets: SttResultPacket[];
  finalSegments: string[];
  boundaryAnalyzed: boolean;
  smartTurnComplete: boolean;
  finalized: boolean;
  analysisSequence: number;
  finalizeTimer: ReturnType<typeof setTimeout> | null;
  maxTimer: ReturnType<typeof setTimeout> | null;
}

export interface SmartTurnPredictor {
  initialize(config: PluginConfig): Promise<void>;
  predict(audio: Float32Array): Promise<number>;
  close(): Promise<void>;
}

export class LocalSmartTurnV3Predictor implements SmartTurnPredictor {
  private ort: Ort | null = null;
  private session: InferenceSession | null = null;
  private readonly featureExtractor = new WhisperFeatureExtractor({
    feature_size: 80,
    sampling_rate: SAMPLE_RATE,
    hop_length: 160,
    n_fft: 400,
    n_samples: MAX_AUDIO_SAMPLES,
    nb_max_frames: 800,
  });

  async initialize(config: PluginConfig): Promise<void> {
    const sampleRate = readNonNegativeNumber(config["sample_rate"], SAMPLE_RATE);
    if (sampleRate !== SAMPLE_RATE) {
      throw new Error(`PipecatEOSPlugin requires 16 kHz PCM input, got ${String(sampleRate)} Hz`);
    }
    const modelPath = optionalStringConfig(config, "model_path") ?? DEFAULT_MODEL_PATH;
    this.ort = await import("onnxruntime-node");
    this.session = await this.ort.InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
      interOpNumThreads: 1,
      intraOpNumThreads: 1,
    });
  }

  async predict(audio: Float32Array): Promise<number> {
    if (!this.ort || !this.session) throw new Error("Smart Turn predictor is not initialized");

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
  }
}

export class PipecatEOSPlugin implements VoicePlugin {
  private bus: PipelineBus | null = null;
  private disposers: Array<() => void> = [];
  private turns = new Map<string, TurnState>();
  private finalizeDelayMs = 250;
  private maxDelayMs = 2000;
  private incompleteFallbackMs = 2000;
  private probabilityThreshold = 0.5;

  constructor(private readonly predictor: SmartTurnPredictor = new LocalSmartTurnV3Predictor()) {}

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    this.finalizeDelayMs = readNonNegativeNumber(config["finalize_delay_ms"], 250);
    this.maxDelayMs = readNonNegativeNumber(config["max_delay_ms"], 2000);
    this.incompleteFallbackMs = readNonNegativeNumber(config["incomplete_fallback_ms"], 2000);
    this.probabilityThreshold = readProbability(config["probability_threshold"], 0.5);
    await this.predictor.initialize(config);

    this.disposers.push(
      bus.on("vad.audio", (pkt) => {
        this.handleAudio(pkt as VadAudioPacket);
      }),
      bus.on("stt.interim", (pkt) => {
        this.handleInterim(pkt as SttInterimPacket);
      }),
      bus.on("stt.result", (pkt) => {
        this.handleFinal(pkt as SttResultPacket);
      }),
      bus.on("vad.speech_started", (pkt) => {
        this.handleSpeechStarted(pkt as VadSpeechStartedPacket);
      }),
      bus.on("vad.speech_ended", async (pkt) => {
        await this.handleSpeechEnded(pkt as VadSpeechEndedPacket);
      }),
    );
  }

  async close(): Promise<void> {
    for (const dispose of this.disposers.splice(0)) {
      dispose();
    }
    for (const state of this.turns.values()) {
      clearTurnTimers(state);
    }
    this.turns.clear();
    await this.predictor.close();
    this.bus = null;
  }

  private handleAudio(pkt: VadAudioPacket): void {
    if (pkt.audio.byteLength % 2 !== 0) return;
    const state = this.stateFor(pkt.contextId);
    const samples = new Int16Array(pkt.audio.buffer, pkt.audio.byteOffset, pkt.audio.byteLength / 2);
    for (const sample of samples) {
      state.audio.push(sample / 32768);
    }
    if (state.audio.length > MAX_AUDIO_SAMPLES) {
      state.audio.splice(0, state.audio.length - MAX_AUDIO_SAMPLES);
    }
  }

  private handleInterim(pkt: SttInterimPacket): void {
    if (!pkt.text.trim()) return;
    this.bus?.push(Route.Main, {
      kind: "eos.interim",
      contextId: pkt.contextId,
      timestampMs: Date.now(),
      text: pkt.text,
    } satisfies InterimEndOfSpeechPacket);
  }

  private handleFinal(pkt: SttResultPacket): void {
    if (!pkt.text.trim()) return;
    const state = this.stateFor(pkt.contextId);
    appendFinalPacket(state, pkt);

    if (state.smartTurnComplete) {
      this.scheduleFinalize(state, this.finalizeDelayMs);
      return;
    }
    if (state.boundaryAnalyzed) {
      this.scheduleIncompleteFallback(state);
      return;
    }
    this.scheduleMaxFinalize(state);
  }

  private handleSpeechStarted(pkt: VadSpeechStartedPacket): void {
    const state = this.stateFor(pkt.contextId);
    state.boundaryAnalyzed = false;
    state.smartTurnComplete = false;
    state.analysisSequence += 1;
    clearTurnTimers(state);
  }

  private async handleSpeechEnded(pkt: VadSpeechEndedPacket): Promise<void> {
    const state = this.stateFor(pkt.contextId);
    const sequence = ++state.analysisSequence;
    const probability = await this.predictor.predict(Float32Array.from(state.audio));
    if (state.finalized || state.analysisSequence !== sequence) return;

    state.boundaryAnalyzed = true;
    state.smartTurnComplete = probability > this.probabilityThreshold;
    if (!state.smartTurnComplete) {
      if (state.maxTimer) {
        clearTimeout(state.maxTimer);
        state.maxTimer = null;
      }
      this.scheduleIncompleteFallback(state);
      return;
    }

    this.requestSttFinalize(state.contextId);
    if (state.finalPackets.length > 0) {
      this.scheduleFinalize(state, this.finalizeDelayMs);
      return;
    }
  }

  private stateFor(contextId: string): TurnState {
    const existing = this.turns.get(contextId);
    if (existing) return existing;

    const state: TurnState = {
      contextId,
      audio: [],
      finalPackets: [],
      finalSegments: [],
      boundaryAnalyzed: false,
      smartTurnComplete: false,
      finalized: false,
      analysisSequence: 0,
      finalizeTimer: null,
      maxTimer: null,
    };
    this.turns.set(contextId, state);
    return state;
  }

  private scheduleFinalize(state: TurnState, delayMs: number): void {
    if (state.finalized || state.finalizeTimer) return;
    state.finalizeTimer = setTimeout(() => {
      state.finalizeTimer = null;
      this.finalize(state);
    }, delayMs);
  }

  private scheduleIncompleteFallback(state: TurnState): void {
    if (state.finalized || state.finalizeTimer) return;
    state.finalizeTimer = setTimeout(() => {
      state.finalizeTimer = null;
      state.smartTurnComplete = true;
      if (state.finalPackets.length > 0) {
        this.finalize(state);
        return;
      }
      this.requestSttFinalize(state.contextId);
    }, this.incompleteFallbackMs);
  }

  private scheduleMaxFinalize(state: TurnState): void {
    if (state.finalized || state.maxTimer || this.maxDelayMs <= 0) return;
    state.maxTimer = setTimeout(() => {
      state.maxTimer = null;
      this.finalize(state);
    }, this.maxDelayMs);
  }

  private finalize(state: TurnState): void {
    const text = state.finalSegments.join(" ").replace(/\s+/g, " ").trim();
    if (state.finalized || state.finalPackets.length === 0 || !text) return;
    state.finalized = true;
    clearTurnTimers(state);
    this.bus?.push(Route.Main, {
      kind: "eos.turn_complete",
      contextId: state.contextId,
      timestampMs: Date.now(),
      text,
      transcripts: state.finalPackets,
    } satisfies EndOfSpeechPacket);
    this.turns.delete(state.contextId);
  }

  private requestSttFinalize(contextId: string): void {
    this.bus?.push(Route.Critical, {
      kind: "stt.finalize",
      contextId,
      timestampMs: Date.now(),
    } satisfies FinalizeSttPacket);
  }
}

function appendFinalPacket(state: TurnState, packet: SttResultPacket): void {
  const text = packet.text.trim();
  if (state.finalSegments.at(-1) === text) return;
  state.finalSegments.push(text);
  state.finalPackets.push(packet);
}

function clearTurnTimers(state: TurnState): void {
  if (state.finalizeTimer) clearTimeout(state.finalizeTimer);
  if (state.maxTimer) clearTimeout(state.maxTimer);
  state.finalizeTimer = null;
  state.maxTimer = null;
}

function readNonNegativeNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function readProbability(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}
