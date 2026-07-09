// SPDX-License-Identifier: MIT

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
      readonly interruptedContextId: string;
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
    }
  | {
      readonly kind: "audio_frame";
      readonly contextId: string;
      readonly timestampMs: number;
      readonly audio?: Int16Array;
      readonly wordTimings?: readonly WordTiming[];
      readonly prosody?: Float32Array;
    }
  | {
      readonly kind: "playout_tick";
      readonly contextId: string;
      readonly timestampMs: number;
      readonly playedOutMs?: number;
      readonly ttsActive?: boolean;
    }
  | {
      readonly kind: "delegate_state";
      readonly contextId: string;
      readonly timestampMs: number;
      readonly delegateInFlight?: boolean;
    };

export type InteractionDecision =
  | { readonly kind: "keep_listening" }
  | { readonly kind: "take_turn"; readonly confidence: number }
  | { readonly kind: "backchannel"; readonly cue: string }
  | { readonly kind: "hold" }
  | { readonly kind: "interrupt"; readonly interruptedContextId: string };

export interface InteractionPolicy {
  observe(obs: InteractionObservation): readonly InteractionDecision[];
  reset(contextId: string): void;
}