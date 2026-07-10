// SPDX-License-Identifier: MIT

import {
  confidenceToWaitMs,
  type InteractionDecision,
  type InteractionObservation,
  type LifecycleInteractionPolicy,
  type PluginConfig,
} from "@kuralle-syrinx/core";

import {
  fuseEndpointDecision,
  latestTranscript,
  scoreSemanticCompleteness,
  type SemanticEndpointFusionConfig,
} from "./semantic-completeness.js";
import { LocalSmartTurnV3Predictor, type SmartTurnPredictor } from "./predictor.js";

const SAMPLE_RATE = 16000;
const DEFAULT_MAX_AUDIO_SAMPLES = SAMPLE_RATE * 8;

interface SmartTurnState {
  readonly contextId: string;
  audio: number[];
  finalSegments: string[];
  latestInterim: string;
  speechActive: boolean;
  boundarySequence: number;
  boundaryAnalyzed: boolean;
  probability: number;
  decisionIssued: boolean;
  pendingDecisions: InteractionDecision[];
  fallbackTimer: ReturnType<typeof setTimeout> | null;
}

export interface SmartTurnInteractionPolicyConfig {
  readonly probability_threshold?: number;
  readonly semantic_endpointing_enabled?: boolean;
  readonly finalize_delay_ms?: number;
  readonly semantic_shortcut_delay_ms?: number;
  readonly incomplete_fallback_ms?: number;
  readonly semantic_defer_fallback_ms?: number;
  readonly max_audio_samples?: number;
}

export class SmartTurnInteractionPolicy implements LifecycleInteractionPolicy {
  private readonly states = new Map<string, SmartTurnState>();
  private probabilityThreshold = 0.5;
  private semanticEndpointingEnabled = true;
  private finalizeDelayMs = 250;
  private semanticShortcutDelayMs = 50;
  private incompleteFallbackMs = 2000;
  private semanticDeferFallbackMs = 4000;
  private maxAudioSamples = DEFAULT_MAX_AUDIO_SAMPLES;
  private initialized = false;

  constructor(private readonly predictor: SmartTurnPredictor = new LocalSmartTurnV3Predictor()) {}

  async initialize(config: PluginConfig = {}): Promise<void> {
    this.probabilityThreshold = readProbability(config["probability_threshold"], 0.5);
    this.semanticEndpointingEnabled = readBoolean(config["semantic_endpointing_enabled"], true);
    this.finalizeDelayMs = readNonNegativeNumber(config["finalize_delay_ms"], 250);
    this.semanticShortcutDelayMs = readNonNegativeNumber(config["semantic_shortcut_delay_ms"], 50);
    this.incompleteFallbackMs = readNonNegativeNumber(config["incomplete_fallback_ms"], 2000);
    this.semanticDeferFallbackMs = readNonNegativeNumber(config["semantic_defer_fallback_ms"], 4000);
    this.maxAudioSamples = readPositiveNumber(config["max_audio_samples"], DEFAULT_MAX_AUDIO_SAMPLES);
    await this.predictor.initialize(config);
    this.initialized = true;
  }

  observe(observation: InteractionObservation): readonly InteractionDecision[] {
    const state = this.stateFor(observation.contextId);
    switch (observation.kind) {
      case "audio_frame":
        this.appendAudio(state, observation.audio);
        break;
      case "stt_partial":
        if (observation.text.trim()) state.latestInterim = observation.text.trim();
        this.evaluateBoundary(state);
        break;
      case "stt_final": {
        const text = observation.text.trim();
        if (text && state.finalSegments.at(-1) !== text) state.finalSegments.push(text);
        state.latestInterim = "";
        this.evaluateBoundary(state);
        break;
      }
      case "vad_speech_started":
        this.beginSpeech(state);
        break;
      case "vad_speech_ended":
        state.speechActive = false;
        this.analyzeBoundary(state);
        break;
      default:
        break;
    }
    return this.drainDecisions(state);
  }

  reset(contextId: string): void {
    const state = this.states.get(contextId);
    if (!state) return;
    this.clearFallback(state);
    state.boundarySequence += 1;
    this.states.delete(contextId);
  }

  async close(): Promise<void> {
    this.initialized = false;
    for (const contextId of [...this.states.keys()]) this.reset(contextId);
    await this.predictor.close();
  }

  private stateFor(contextId: string): SmartTurnState {
    const existing = this.states.get(contextId);
    if (existing) return existing;
    const state: SmartTurnState = {
      contextId,
      audio: [],
      finalSegments: [],
      latestInterim: "",
      speechActive: false,
      boundarySequence: 0,
      boundaryAnalyzed: false,
      probability: 0,
      decisionIssued: false,
      pendingDecisions: [],
      fallbackTimer: null,
    };
    this.states.set(contextId, state);
    return state;
  }

  private beginSpeech(state: SmartTurnState): void {
    this.clearFallback(state);
    state.audio = [];
    state.finalSegments = [];
    state.latestInterim = "";
    state.speechActive = true;
    state.boundarySequence += 1;
    state.boundaryAnalyzed = false;
    state.probability = 0;
    state.decisionIssued = false;
    state.pendingDecisions = [];
  }

  private appendAudio(state: SmartTurnState, audio?: Int16Array): void {
    if (!audio?.length) return;
    for (const sample of audio) state.audio.push(sample / 32768);
    const overflow = state.audio.length - this.maxAudioSamples;
    if (overflow > 0) state.audio.splice(0, overflow);
  }

  private analyzeBoundary(state: SmartTurnState): void {
    if (!this.initialized || state.decisionIssued) return;
    const sequence = ++state.boundarySequence;
    const audio = Float32Array.from(state.audio);
    void this.predictor.predict(audio).then(
      (probability) => {
        if (!this.initialized || state.boundarySequence !== sequence || !this.states.has(state.contextId)) return;
        state.probability = clampProbability(probability);
        state.boundaryAnalyzed = true;
        this.evaluateBoundary(state);
      },
      () => {
        if (!this.initialized || state.boundarySequence !== sequence || !this.states.has(state.contextId)) return;
        state.boundaryAnalyzed = true;
        state.probability = 0;
        this.scheduleFallback(state, this.incompleteFallbackMs);
      },
    );
  }

  private evaluateBoundary(state: SmartTurnState): void {
    if (!state.boundaryAnalyzed || state.speechActive || state.decisionIssued) return;
    const smartTurnComplete = state.probability > this.probabilityThreshold;
    const transcript = latestTranscript(state.finalSegments, state.latestInterim);
    if (!transcript) {
      if (smartTurnComplete) this.issueTakeTurn(state, state.probability);
      else this.scheduleFallback(state, this.incompleteFallbackMs);
      return;
    }

    const semantic = scoreSemanticCompleteness(transcript);
    const fusion = fuseEndpointDecision(smartTurnComplete, semantic, this.fusionConfig());
    if (fusion.release) {
      const confidence = smartTurnComplete ? Math.max(state.probability, semantic.confidence) : semantic.confidence;
      this.issueTakeTurn(state, confidence);
      return;
    }

    if (!state.pendingDecisions.some((decision) => decision.kind === "hold")) {
      state.pendingDecisions.push({ kind: "hold" });
    }
    this.scheduleFallback(
      state,
      fusion.deferReason ? this.semanticDeferFallbackMs : fusion.finalizeDelayMs,
    );
  }

  private issueTakeTurn(state: SmartTurnState, confidence: number): void {
    if (state.decisionIssued) return;
    this.clearFallback(state);
    state.decisionIssued = true;
    state.pendingDecisions.push({
      kind: "take_turn",
      confidence,
      waitMs: confidenceToWaitMs(confidence),
    });
  }

  private scheduleFallback(state: SmartTurnState, delayMs: number): void {
    if (state.fallbackTimer || state.decisionIssued) return;
    state.fallbackTimer = setTimeout(() => {
      state.fallbackTimer = null;
      if (!this.initialized || state.speechActive || state.decisionIssued || !this.states.has(state.contextId)) return;
      state.decisionIssued = true;
      state.pendingDecisions.push({ kind: "take_turn", confidence: 0, waitMs: 0 });
    }, delayMs);
  }

  private clearFallback(state: SmartTurnState): void {
    if (!state.fallbackTimer) return;
    clearTimeout(state.fallbackTimer);
    state.fallbackTimer = null;
  }

  private drainDecisions(state: SmartTurnState): readonly InteractionDecision[] {
    if (state.pendingDecisions.length === 0) return [];
    return state.pendingDecisions.splice(0);
  }

  private fusionConfig(): SemanticEndpointFusionConfig {
    return {
      enabled: this.semanticEndpointingEnabled,
      finalizeDelayMs: this.finalizeDelayMs,
      semanticShortcutDelayMs: this.semanticShortcutDelayMs,
      incompleteFallbackMs: this.incompleteFallbackMs,
    };
  }
}

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readNonNegativeNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function readPositiveNumber(value: unknown, fallback: number): number {
  const parsed = readNonNegativeNumber(value, fallback);
  return parsed > 0 ? parsed : fallback;
}

function readProbability(value: unknown, fallback: number): number {
  return typeof value === "number" ? clampProbability(value) : fallback;
}
