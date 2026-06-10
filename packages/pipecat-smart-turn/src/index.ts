// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 - Pipecat Smart Turn Plugin
//
// Mirrors Pipecat's LocalSmartTurnAnalyzerV3 turn-stop strategy:
// Silero determines candidate speech boundaries, then Smart Turn v3 decides
// whether a pause is an actual completed user turn.

import { fileURLToPath } from "node:url";

import {
  fuseEndpointDecision,
  latestTranscript,
  scoreSemanticCompleteness,
  type SemanticEndpointFusionConfig,
} from "./semantic-completeness.js";
import {
  Route,
  type EndOfSpeechPacket,
  type FinalizeSttPacket,
  type InterruptionDetectedPacket,
  type InterimEndOfSpeechPacket,
  type PipelineBus,
  type PluginConfig,
  type SttInterimPacket,
  type SttResultPacket,
  type TextToSpeechAudioPacket,
  type TextToSpeechEndPacket,
  type TextToSpeechPlayoutProgressPacket,
  type VadAudioPacket,
  type VadSpeechEndedPacket,
  type VadSpeechStartedPacket,
  type VoicePlugin,
  optionalStringConfig,
} from "@kuralle-syrinx/core";
import { pcm16BytesToSamples } from "@kuralle-syrinx/core/audio";

type Ort = typeof import("onnxruntime-node");
type InferenceSession = import("onnxruntime-node").InferenceSession;
interface FeatureExtractor {
  _extract_fbank_features(audio: Float32Array): Promise<{ data: unknown }>;
}

const SAMPLE_RATE = 16000;
const MAX_AUDIO_SAMPLES = SAMPLE_RATE * 8;
const DEFAULT_MODEL_PATH = fileURLToPath(new URL("../models/smart-turn-v3.2-cpu.onnx", import.meta.url));

interface TurnState {
  readonly contextId: string;
  audio: number[];
  finalPackets: SttResultPacket[];
  finalSegments: string[];
  latestInterim: string;
  boundaryAnalyzed: boolean;
  smartTurnComplete: boolean;
  semanticComplete: boolean;
  speechActive: boolean;
  finalized: boolean;
  analysisSequence: number;
  finalizeTimer: ReturnType<typeof setTimeout> | null;
  sttQuietTimer: ReturnType<typeof setTimeout> | null;
  maxTimer: ReturnType<typeof setTimeout> | null;
  deferTimer: ReturnType<typeof setTimeout> | null;
}

export interface SmartTurnPredictor {
  initialize(config: PluginConfig): Promise<void>;
  predict(audio: Float32Array): Promise<number>;
  close(): Promise<void>;
}

export class LocalSmartTurnV3Predictor implements SmartTurnPredictor {
  private ort: Ort | null = null;
  private session: InferenceSession | null = null;
  private featureExtractor: FeatureExtractor | null = null;

  async initialize(config: PluginConfig): Promise<void> {
    const sampleRate = readNonNegativeNumber(config["sample_rate"], SAMPLE_RATE);
    if (sampleRate !== SAMPLE_RATE) {
      throw new Error(`PipecatEOSPlugin requires 16 kHz PCM input, got ${String(sampleRate)} Hz`);
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
    if (!this.ort || !this.session || !this.featureExtractor) throw new Error("Smart Turn predictor is not initialized");

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

export class PipecatEOSPlugin implements VoicePlugin {
  readonly endpointingCapability = { owner: "smart_turn" as const };

  private bus: PipelineBus | null = null;
  private disposers: Array<() => void> = [];
  private turns = new Map<string, TurnState>();
  private finalizeDelayMs = 250;
  private sttQuietFallbackMs = 2500;
  private maxDelayMs = 2000;
  private incompleteFallbackMs = 2000;
  private semanticShortcutDelayMs = 50;
  private semanticDeferFallbackMs = 4000;
  private semanticEndpointingEnabled = true;
  private probabilityThreshold = 0.5;
  private readonly lockedContextIds = new Set<string>();
  private readonly lockedContextsWithAssistantAudio = new Set<string>();

  constructor(private readonly predictor: SmartTurnPredictor = new LocalSmartTurnV3Predictor()) {}

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    this.finalizeDelayMs = readNonNegativeNumber(config["finalize_delay_ms"], 250);
    this.sttQuietFallbackMs = readNonNegativeNumber(config["stt_quiet_fallback_ms"], 2500);
    this.maxDelayMs = readNonNegativeNumber(config["max_delay_ms"], 2000);
    this.incompleteFallbackMs = readNonNegativeNumber(config["incomplete_fallback_ms"], 2000);
    this.semanticShortcutDelayMs = readNonNegativeNumber(config["semantic_shortcut_delay_ms"], 50);
    this.semanticDeferFallbackMs = readNonNegativeNumber(config["semantic_defer_fallback_ms"], 4000);
    this.semanticEndpointingEnabled = readBooleanConfig(config["semantic_endpointing_enabled"], true);
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
      bus.on("tts.audio", (pkt) => {
        this.handleTtsAudio(pkt as TextToSpeechAudioPacket);
      }),
      bus.on("tts.end", (pkt) => {
        this.handleTtsEnd(pkt as TextToSpeechEndPacket);
      }),
      bus.on("tts.playout_progress", (pkt) => {
        this.handleTtsPlayoutProgress(pkt as TextToSpeechPlayoutProgressPacket);
      }),
      bus.on("interrupt.detected", (pkt) => {
        this.releaseContextLock((pkt as InterruptionDetectedPacket).contextId);
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
    this.lockedContextIds.clear();
    this.lockedContextsWithAssistantAudio.clear();
    await this.predictor.close();
    this.bus = null;
  }

  private handleAudio(pkt: VadAudioPacket): void {
    if (this.lockedContextIds.has(pkt.contextId)) return;
    if (pkt.audio.byteLength % 2 !== 0) return;
    const state = this.stateFor(pkt.contextId);
    const samples = pcm16BytesToSamples(pkt.audio);
    for (const sample of samples) {
      state.audio.push(sample / 32768);
    }
    if (state.audio.length > MAX_AUDIO_SAMPLES) {
      state.audio.splice(0, state.audio.length - MAX_AUDIO_SAMPLES);
    }
  }

  private handleInterim(pkt: SttInterimPacket): void {
    if (this.lockedContextIds.has(pkt.contextId)) return;
    if (!pkt.text.trim()) return;
    const state = this.stateFor(pkt.contextId);
    state.latestInterim = pkt.text.trim();
    if (state.sttQuietTimer) this.armSttQuietFallback(state);
    this.bus?.push(Route.Main, {
      kind: "eos.interim",
      contextId: pkt.contextId,
      timestampMs: Date.now(),
      text: pkt.text,
    } satisfies InterimEndOfSpeechPacket);
  }

  private handleFinal(pkt: SttResultPacket): void {
    if (this.lockedContextIds.has(pkt.contextId)) return;
    if (!pkt.text.trim()) return;
    const state = this.stateFor(pkt.contextId);
    appendFinalPacket(state, pkt);
    state.latestInterim = "";

    const transcript = latestTranscript(state.finalSegments, state.latestInterim);
    const semantic = scoreSemanticCompleteness(transcript);
    state.semanticComplete = semantic.complete;

    if (state.boundaryAnalyzed && state.smartTurnComplete && state.semanticComplete) {
      this.scheduleFinalize(state, this.finalizeDelayMs);
      return;
    }
    if (state.smartTurnComplete && state.semanticComplete) {
      this.scheduleFinalize(state, this.finalizeDelayMs);
      return;
    }
    if (state.boundaryAnalyzed && state.smartTurnComplete && !state.semanticComplete) {
      return;
    }
    if (state.boundaryAnalyzed && !state.smartTurnComplete && state.semanticComplete) {
      this.scheduleSemanticShortcut(state);
      return;
    }
    if (state.boundaryAnalyzed) {
      this.scheduleIncompleteFallback(state);
      return;
    }
    if (state.speechActive) {
      this.armSttQuietFallback(state);
      return;
    }
    this.scheduleMaxFinalize(state);
  }

  private handleSpeechStarted(pkt: VadSpeechStartedPacket): void {
    if (this.lockedContextIds.has(pkt.contextId)) return;
    const state = this.stateFor(pkt.contextId);
    if (state.sttQuietTimer) {
      clearTimeout(state.sttQuietTimer);
      state.sttQuietTimer = null;
    }
    state.boundaryAnalyzed = false;
    state.smartTurnComplete = false;
    state.semanticComplete = false;
    state.speechActive = true;
    state.latestInterim = "";
    state.analysisSequence += 1;
    clearTurnTimers(state);
  }

  private async handleSpeechEnded(pkt: VadSpeechEndedPacket): Promise<void> {
    if (this.lockedContextIds.has(pkt.contextId)) return;
    const state = this.stateFor(pkt.contextId);
    if (state.sttQuietTimer) {
      clearTimeout(state.sttQuietTimer);
      state.sttQuietTimer = null;
    }
    await this.analyzeBoundary(state);
  }

  // Shared end-of-speech boundary analysis: used by the VAD speech_ended path
  // and by the STT-quiet fallback (when the provider transcript has gone quiet
  // but the VAD never closed the segment — e.g. model state saturation on long
  // telephony audio). The turn must never be held hostage by a wedged VAD.
  private async analyzeBoundary(state: TurnState): Promise<void> {
    state.speechActive = false;
    const sequence = ++state.analysisSequence;
    const probability = await this.predictor.predict(Float32Array.from(state.audio));
    if (state.finalized || state.analysisSequence !== sequence) return;

    state.boundaryAnalyzed = true;
    state.smartTurnComplete = probability > this.probabilityThreshold;

    const transcript = latestTranscript(state.finalSegments, state.latestInterim);
    const semantic = transcript.trim()
      ? scoreSemanticCompleteness(transcript)
      : { complete: state.smartTurnComplete, label: "complete" as const, confidence: 0 };
    state.semanticComplete = semantic.complete;

    const fusion = transcript.trim()
      ? fuseEndpointDecision(state.smartTurnComplete, semantic, this.fusionConfig())
      : {
          release: state.smartTurnComplete,
          requestFinalize: state.smartTurnComplete,
          finalizeDelayMs: this.finalizeDelayMs,
        };

    if (state.maxTimer) {
      clearTimeout(state.maxTimer);
      state.maxTimer = null;
    }

    if (fusion.deferReason) {
      this.scheduleSemanticDefer(state);
      return;
    }

    if (!fusion.release) {
      this.scheduleIncompleteFallback(state);
      return;
    }

    if (fusion.requestFinalize) {
      this.requestSttFinalize(state.contextId);
    }
    if (state.finalPackets.length > 0) {
      this.scheduleFinalize(state, fusion.finalizeDelayMs);
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
      latestInterim: "",
      boundaryAnalyzed: false,
      smartTurnComplete: false,
      semanticComplete: false,
      speechActive: false,
      finalized: false,
      analysisSequence: 0,
      finalizeTimer: null,
      sttQuietTimer: null,
      maxTimer: null,
      deferTimer: null,
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

  private scheduleSemanticShortcut(state: TurnState): void {
    if (state.finalized || state.finalizeTimer) return;
    state.finalizeTimer = setTimeout(() => {
      state.finalizeTimer = null;
      state.smartTurnComplete = true;
      this.requestSttFinalize(state.contextId);
      if (state.finalPackets.length > 0) {
        this.finalize(state);
      }
    }, this.semanticShortcutDelayMs);
  }

  private scheduleSemanticDefer(state: TurnState): void {
    if (state.finalized || state.deferTimer) return;
    state.deferTimer = setTimeout(() => {
      state.deferTimer = null;
      if (state.finalized || state.speechActive) return;
      const transcript = latestTranscript(state.finalSegments, state.latestInterim);
      const semantic = scoreSemanticCompleteness(transcript);
      state.smartTurnComplete = true;
      this.requestSttFinalize(state.contextId);
      if (state.finalPackets.length > 0) {
        if (semantic.complete) {
          state.semanticComplete = true;
          this.scheduleFinalize(state, this.finalizeDelayMs);
        } else {
          this.finalize(state);
        }
      }
    }, this.semanticDeferFallbackMs);
  }

  private fusionConfig(): SemanticEndpointFusionConfig {
    return {
      enabled: this.semanticEndpointingEnabled,
      finalizeDelayMs: this.finalizeDelayMs,
      semanticShortcutDelayMs: this.semanticShortcutDelayMs,
      incompleteFallbackMs: this.incompleteFallbackMs,
    };
  }

  private armSttQuietFallback(state: TurnState): void {
    if (this.sttQuietFallbackMs <= 0 || state.finalized) return;
    if (state.sttQuietTimer) clearTimeout(state.sttQuietTimer);
    state.sttQuietTimer = setTimeout(() => {
      state.sttQuietTimer = null;
      if (state.finalized || !state.speechActive || state.finalPackets.length === 0) return;
      this.bus?.push(Route.Main, {
        kind: "metric.conversation",
        contextId: state.contextId,
        timestampMs: Date.now(),
        name: "eos.stt_quiet_fallback",
        value: String(this.sttQuietFallbackMs),
      });
      void this.analyzeBoundary(state);
    }, this.sttQuietFallbackMs);
  }

  private scheduleMaxFinalize(state: TurnState): void {
    if (state.finalized || state.maxTimer || this.maxDelayMs <= 0) return;
    state.maxTimer = setTimeout(() => {
      state.maxTimer = null;
      this.finalize(state);
    }, this.maxDelayMs);
  }

  private handleTtsAudio(pkt: TextToSpeechAudioPacket): void {
    if (this.lockedContextIds.has(pkt.contextId)) {
      this.lockedContextsWithAssistantAudio.add(pkt.contextId);
    }
  }

  private handleTtsEnd(pkt: TextToSpeechEndPacket): void {
    if (!this.lockedContextsWithAssistantAudio.has(pkt.contextId)) {
      this.releaseContextLock(pkt.contextId);
    }
  }

  private handleTtsPlayoutProgress(pkt: TextToSpeechPlayoutProgressPacket): void {
    if (pkt.complete) this.releaseContextLock(pkt.contextId);
  }

  private releaseContextLock(contextId: string): void {
    this.lockedContextIds.delete(contextId);
    this.lockedContextsWithAssistantAudio.delete(contextId);
  }

  private finalize(state: TurnState): void {
    const text = state.finalSegments.join(" ").replace(/\s+/g, " ").trim();
    if (state.finalized || state.finalPackets.length === 0 || !text) return;
    state.finalized = true;
    this.lockedContextIds.add(state.contextId);
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
  if (state.sttQuietTimer) clearTimeout(state.sttQuietTimer);
  if (state.maxTimer) clearTimeout(state.maxTimer);
  if (state.deferTimer) clearTimeout(state.deferTimer);
  state.finalizeTimer = null;
  state.sttQuietTimer = null;
  state.maxTimer = null;
  state.deferTimer = null;
}

function readBooleanConfig(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  return fallback;
}

export {
  fuseEndpointDecision,
  latestTranscript,
  scoreSemanticCompleteness,
  type EndpointFusionDecision,
  type SemanticCompletenessLabel,
  type SemanticCompletenessScore,
  type SemanticEndpointFusionConfig,
} from "./semantic-completeness.js";
export { SEMANTIC_LABELED_UTTERANCES, type SemanticLabeledUtterance } from "./semantic-fixtures.js";

function readNonNegativeNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function readProbability(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}
