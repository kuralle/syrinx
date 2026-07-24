// SPDX-License-Identifier: MIT

import type { AcousticSignal } from "./packets.js";

export interface WordTiming {
  readonly word: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly confidence: number;
}

export type InteractionObservation =
  | {
      readonly kind: "vad_speech_started";
      readonly contextId: string;
      readonly timestampMs: number;
      readonly confidence: number;
      readonly interruptedContextId?: string;
    }
  | {
      readonly kind: "vad_speech_activity";
      readonly contextId: string;
      readonly timestampMs: number;
    }
  | {
      readonly kind: "vad_speech_ended";
      readonly contextId: string;
      readonly timestampMs: number;
      readonly hasActiveTts: boolean;
    }
  | {
      readonly kind: "vad_barge_in_audio";
      readonly contextId: string;
      readonly timestampMs: number;
      readonly audio: Uint8Array;
    }
  | {
      readonly kind: "stt_partial";
      readonly contextId: string;
      readonly timestampMs: number;
      readonly text: string;
      readonly confidence?: number;
      readonly interruptedContextId?: string;
      readonly wordTimings?: readonly WordTiming[];
    }
  | {
      readonly kind: "stt_final";
      readonly contextId: string;
      readonly timestampMs: number;
      readonly text: string;
      readonly confidence?: number;
      readonly interruptedContextId?: string;
      readonly wordTimings?: readonly WordTiming[];
    }
  | {
      readonly kind: "audio_frame";
      readonly contextId: string;
      readonly timestampMs: number;
      readonly audio?: Int16Array;
      readonly sampleRateHz?: number;
      readonly wordTimings?: readonly WordTiming[];
      readonly prosody?: Float32Array;
    }
  | {
      readonly kind: "playout_tick";
      readonly contextId: string;
      readonly timestampMs: number;
      readonly playedOutMs?: number;
      readonly ttsActive?: boolean;
      /** PCM queued for assistant playout. Present on audio-bearing ticks. */
      readonly audio?: Int16Array;
      readonly sampleRateHz?: number;
    }
  | {
      readonly kind: "delegate_state";
      readonly contextId: string;
      readonly timestampMs: number;
      readonly delegateInFlight?: boolean;
      readonly toolCallPhase?: "started" | "delayed" | "complete" | "failed";
    };

export type InteractionDecision =
  | { readonly kind: "keep_listening" }
  | { readonly kind: "take_turn"; readonly confidence: number; readonly waitMs?: number }
  /** `cue` is a stable pre-cached asset id (e.g. `mm_hmm`), not free-form text. */
  | { readonly kind: "backchannel"; readonly cue: string }
  | { readonly kind: "hold" }
  | { readonly kind: "interrupt"; readonly interruptedContextId: string };

export interface AcousticSignalObservation {
  readonly contextId: string;
  readonly timestampMs: number;
  readonly signal: AcousticSignal;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export type AcousticSignalSink = (signal: AcousticSignalObservation) => void;

export interface InteractionPolicy {
  observe(obs: InteractionObservation): readonly InteractionDecision[];
  reset(contextId: string): void;
  setAcousticSignalSink?(sink: AcousticSignalSink): void;
}

/** Optional lifecycle for externally supplied model policies (session-owned). */
export interface LifecycleInteractionPolicy extends InteractionPolicy {
  initialize(config: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

export function isLifecycleInteractionPolicy(
  policy: InteractionPolicy,
): policy is LifecycleInteractionPolicy {
  const candidate = policy as LifecycleInteractionPolicy;
  return typeof candidate.initialize === "function" && typeof candidate.close === "function";
}
