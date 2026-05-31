// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Packet Type Definitions
//
// Every packet flowing through the PipelineBus uses these types.
// Naming convention:
//   Commands (verb-first):  InterruptTts, DenoiseAudio, ExecuteLlm
//   Events  (past-tense):   VadSpeechStarted, SttResult, LlmResponseDelta
//   Errors:                 SttError, TtsError, LlmError
//   Lifecycle:              InitStepCompleted, InitFailed, InitCompleted

// =============================================================================
// Base Types
// =============================================================================

/** Every packet flowing through the bus has these fields. */
export interface VoicePacket {
  /** Discriminator. Examples: "stt.result", "vad.speech_started", "init.failed" */
  readonly kind: string;
  /** Turn or session identifier. Empty string for session-scoped packets. */
  readonly contextId: string;
  /** Wall-clock creation time in ms since epoch. */
  readonly timestampMs: number;
}

/** Marker: this packet's handler runs fire-and-forget (not awaited). */
export interface AsyncPacket extends VoicePacket {
  readonly isAsync: true;
}

// =============================================================================
// Error Types
// =============================================================================

/** Categorized error types across all external-service components. */
export enum ErrorCategory {
  RateLimit = "rate_limit",           // HTTP 429 / quota exceeded — recoverable
  NetworkTimeout = "network_timeout", // connection timeout / ECONNRESET — recoverable
  Authentication = "authentication",  // HTTP 401/403 — fatal
  InvalidInput = "invalid_input",     // HTTP 400 / invalid audio format — fatal
  InternalFault = "internal_fault",   // unexpected provider error — fatal
  ResourceExhausted = "resource_exhausted", // credits depleted — fatal
}

export interface VoiceErrorPacket extends VoicePacket {
  /** Which component emitted the error. */
  readonly component: "stt" | "tts" | "vad" | "eos" | "denoiser" | "llm" | "bridge" | "pipeline";
  /** Machine-readable error category. */
  readonly category: ErrorCategory;
  /** Original error. May contain provider-specific details. */
  readonly cause: Error;
  /** Whether the session manager should retry (true) or terminate (false). */
  readonly isRecoverable: boolean;
}

// =============================================================================
// Lifecycle Types
// =============================================================================

export enum SessionState {
  Uninitialized = "uninitialized",
  Initializing = "initializing",
  Ready = "ready",
  Finalizing = "finalizing",
  Closed = "closed",
  Failed = "failed",
}

export enum InitStage {
  Assistant = "assistant",
  Conversation = "conversation",
  Recorder = "recorder",
  Normalizer = "normalizer",
  Auth = "auth",
  STT = "stt",
  TTS = "tts",
  VAD = "vad",
  EOS = "eos",
  Denoiser = "denoiser",
  Behavior = "behavior",
  Telemetry = "telemetry",
}

export interface InitStepCompletedPacket extends VoicePacket {
  readonly kind: "init.step_completed";
  readonly stage: InitStage;
  readonly component: string;
  /** Milliseconds taken to initialize this component. */
  readonly initMs: number;
}

export interface InitializationFailedPacket extends VoicePacket {
  readonly kind: "init.failed";
  readonly stage: InitStage;
  readonly component: string;
  readonly category: ErrorCategory;
  readonly cause: Error;
  readonly isRecoverable: false;
}

export interface InitializationCompletedPacket extends VoicePacket {
  readonly kind: "init.completed";
}

// =============================================================================
// Input Pipeline Packets (user audio → transcript)
// =============================================================================

export interface UserAudioReceivedPacket extends VoicePacket {
  readonly kind: "user.audio_received";
  /** Raw PCM audio (16-bit, mono, 16kHz). */
  readonly audio: Uint8Array;
}

export interface UserTextReceivedPacket extends VoicePacket {
  readonly kind: "user.text_received";
  readonly text: string;
}

export interface DenoiseAudioPacket extends VoicePacket {
  readonly kind: "denoise.audio";
  readonly audio: Uint8Array;
}

export interface DenoisedAudioPacket extends VoicePacket {
  readonly kind: "denoise.result";
  readonly audio: Uint8Array;
  readonly noiseReduced: boolean;
  readonly confidence: number;
}

export interface VadAudioPacket extends VoicePacket {
  readonly kind: "vad.audio";
  readonly audio: Uint8Array;
}

export interface VadSpeechStartedPacket extends VoicePacket {
  readonly kind: "vad.speech_started";
  readonly confidence: number;
}

export interface VadSpeechEndedPacket extends VoicePacket {
  readonly kind: "vad.speech_ended";
}

/** Heartbeat emitted on every audio chunk during active speech. EOS uses this to extend its timer. */
export interface VadSpeechActivityPacket extends VoicePacket, AsyncPacket {
  readonly kind: "vad.speech_activity";
  readonly isAsync: true;
}

export interface SpeechToTextAudioPacket extends VoicePacket {
  readonly kind: "stt.audio";
  readonly audio: Uint8Array;
}

export interface SttInterimPacket extends VoicePacket {
  readonly kind: "stt.interim";
  readonly text: string;
}

export interface SttResultPacket extends VoicePacket {
  readonly kind: "stt.result";
  readonly text: string;
  readonly confidence: number;
  readonly language?: string;
}

/** Requests that a streaming STT plugin publish its accumulated final transcript. */
export interface FinalizeSttPacket extends VoicePacket {
  readonly kind: "stt.finalize";
}

export interface SttErrorPacket extends VoicePacket, VoiceErrorPacket {
  readonly kind: "stt.error";
  readonly component: "stt";
}

export interface EndOfSpeechAudioPacket extends VoicePacket {
  readonly kind: "eos.audio";
  readonly audio: Uint8Array;
}

export interface EndOfSpeechPacket extends VoicePacket {
  readonly kind: "eos.turn_complete";
  readonly text: string;
  /** All accumulated STT transcripts for this turn. */
  readonly transcripts: readonly SttResultPacket[];
}

export interface InterimEndOfSpeechPacket extends VoicePacket {
  readonly kind: "eos.interim";
  readonly text: string;
}

// =============================================================================
// User Input (processed — feeds LLM)
// =============================================================================

export interface UserInputPacket extends VoicePacket {
  readonly kind: "user.input";
  readonly text: string;
  readonly language: string;
}

// =============================================================================
// Interruption Packets (flow through Critical route)
// =============================================================================

export type InterruptionSource = "vad" | "word";

export interface InterruptionDetectedPacket extends VoicePacket {
  readonly kind: "interrupt.detected";
  readonly source: InterruptionSource;
}

export interface InterruptTtsPacket extends VoicePacket {
  readonly kind: "interrupt.tts";
}

export interface InterruptLlmPacket extends VoicePacket {
  readonly kind: "interrupt.llm";
}

export interface InterruptSttPacket extends VoicePacket {
  readonly kind: "interrupt.stt";
}

export interface TurnChangePacket extends VoicePacket {
  readonly kind: "turn.change";
  readonly previousContextId: string;
  readonly reason: string;
}

// =============================================================================
// LLM Pipeline Packets
// =============================================================================

export interface LlmDeltaPacket extends VoicePacket {
  readonly kind: "llm.delta";
  readonly text: string;
}

export interface LlmResponseDonePacket extends VoicePacket {
  readonly kind: "llm.done";
  readonly text: string;
}

export interface LlmErrorPacket extends VoicePacket, VoiceErrorPacket {
  readonly kind: "llm.error";
  readonly component: "llm" | "bridge";
}

export interface LlmToolCallPacket extends VoicePacket {
  readonly kind: "llm.tool_call";
  readonly toolId: string;
  readonly toolName: string;
  readonly toolArgs: Record<string, unknown>;
}

export interface LlmToolResultPacket extends VoicePacket {
  readonly kind: "llm.tool_result";
  readonly toolId: string;
  readonly toolName: string;
  readonly result: string;
}

// =============================================================================
// Output Pipeline Packets (LLM text → TTS audio)
// =============================================================================

export interface TextToSpeechTextPacket extends VoicePacket {
  readonly kind: "tts.text";
  readonly text: string;
}

export interface TextToSpeechDonePacket extends VoicePacket {
  readonly kind: "tts.done";
  readonly text: string;
}

export interface TextToSpeechAudioPacket extends VoicePacket {
  readonly kind: "tts.audio";
  /** PCM audio bytes (16-bit, mono). */
  readonly audio: Uint8Array;
  /** Source sample rate for the PCM payload. */
  readonly sampleRateHz: number;
}

export interface TextToSpeechEndPacket extends VoicePacket {
  readonly kind: "tts.end";
}

export interface TtsWordTimestamp {
  readonly word: string;
  /** Milliseconds from the start of audio for this TTS context. */
  readonly startMs: number;
  /** Milliseconds from the start of audio for this TTS context. */
  readonly endMs: number;
}

/**
 * Word-level timestamps for a TTS audio chunk, emitted by TTS plugins that
 * support them (Cartesia, ElevenLabs). Enables the bridge to compute the spoken
 * prefix (G2/G25): the subset of assistant text the user actually heard, used to
 * rewrite history on barge-in at word granularity instead of text granularity.
 * Times are cumulative from the start of the context's audio stream.
 */
export interface TextToSpeechWordTimestampsPacket extends VoicePacket {
  readonly kind: "tts.word_timestamps";
  readonly words: readonly TtsWordTimestamp[];
}

export interface TtsErrorPacket extends VoicePacket, VoiceErrorPacket {
  readonly kind: "tts.error";
  readonly component: "tts";
}

/**
 * Realtime playout position for a context, emitted by the output transport's
 * paced-playout layer as audio actually reaches the wire. This is the
 * authoritative playout clock; turn-taking and recording consume it instead of
 * reconstructing timing from generation arrival. Absent when no paced transport
 * is wired (e.g. headless), in which case consumers fall back to a
 * sample-duration estimate.
 */
export interface TextToSpeechPlayoutProgressPacket extends VoicePacket {
  readonly kind: "tts.playout_progress";
  /** Cumulative realtime audio (ms) paced out to the wire for this context. */
  readonly playedOutMs: number;
  /** True on the final progress for the context — all generated audio has played out. */
  readonly complete: boolean;
}

// =============================================================================
// Recording Packets
// =============================================================================

export interface RecordUserAudioPacket extends VoicePacket {
  readonly kind: "record.user_audio";
  readonly audio: Uint8Array;
}

export interface RecordAssistantAudioDataPacket extends VoicePacket {
  readonly kind: "record.assistant_audio";
  readonly audio: Uint8Array;
  /** Source sample rate for assistant PCM. */
  readonly sampleRateHz: number;
  readonly truncate: false;
}

export interface RecordAssistantAudioTruncatePacket extends VoicePacket {
  readonly kind: "record.assistant_audio";
  readonly audio: Uint8Array;
  readonly truncate: true;
}

export type RecordAssistantAudioPacket = RecordAssistantAudioDataPacket | RecordAssistantAudioTruncatePacket;

// =============================================================================
// Behavior Packets
// =============================================================================

export interface StartIdleTimeoutPacket extends VoicePacket {
  readonly kind: "behavior.idle_timeout_start";
}

export interface StopIdleTimeoutPacket extends VoicePacket {
  readonly kind: "behavior.idle_timeout_stop";
  readonly resetCount: boolean;
}

export interface InjectMessagePacket extends VoicePacket {
  readonly kind: "inject.message";
  readonly text: string;
}

export interface DisconnectRequestedPacket extends VoicePacket {
  readonly kind: "session.disconnect";
  readonly reason: string;
}

// =============================================================================
// Mode Switching Packets
// =============================================================================

export interface ModeSwitchRequestedPacket extends VoicePacket {
  readonly kind: "mode.switch_requested";
  readonly mode: "text" | "audio";
}

export interface ModeSwitchCompletedPacket extends VoicePacket {
  readonly kind: "mode.switch_completed";
  readonly mode: "text" | "audio";
}

// =============================================================================
// Persistence Packets
// =============================================================================

export interface MessageCreatePacket extends VoicePacket {
  readonly kind: "message.create";
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
}

// =============================================================================
// Metric / Metadata Packets (Background route)
// =============================================================================

export interface ConversationMetricPacket extends VoicePacket {
  readonly kind: "metric.conversation";
  readonly name: string;
  readonly value: string;
}

export interface PipelineErrorPacket extends VoicePacket, VoiceErrorPacket {
  readonly kind: "pipeline.error";
  readonly component: "pipeline";
}

// =============================================================================
// Convenience union types
// =============================================================================

/** All input pipeline packets. */
export type InputPacket =
  | UserAudioReceivedPacket
  | UserTextReceivedPacket
  | DenoiseAudioPacket
  | DenoisedAudioPacket
  | VadAudioPacket
  | VadSpeechStartedPacket
  | VadSpeechEndedPacket
  | VadSpeechActivityPacket
  | SpeechToTextAudioPacket
  | SttInterimPacket
  | SttResultPacket
  | FinalizeSttPacket
  | SttErrorPacket
  | EndOfSpeechAudioPacket
  | EndOfSpeechPacket
  | InterimEndOfSpeechPacket
  | UserInputPacket;

/** All interruption packets (Critical route). */
export type InterruptPacket =
  | InterruptionDetectedPacket
  | InterruptTtsPacket
  | InterruptLlmPacket
  | InterruptSttPacket
  | TurnChangePacket;

/** All LLM output packets. */
export type LlmPacket =
  | LlmDeltaPacket
  | LlmResponseDonePacket
  | LlmErrorPacket
  | LlmToolCallPacket
  | LlmToolResultPacket;

/** All TTS output packets. */
export type TtsPacket =
  | TextToSpeechTextPacket
  | TextToSpeechDonePacket
  | TextToSpeechAudioPacket
  | TextToSpeechEndPacket
  | TextToSpeechPlayoutProgressPacket
  | TextToSpeechWordTimestampsPacket
  | TtsErrorPacket;

/** All error packets (any component). */
export type AnyErrorPacket =
  | SttErrorPacket
  | TtsErrorPacket
  | LlmErrorPacket
  | PipelineErrorPacket
  | InitializationFailedPacket;
