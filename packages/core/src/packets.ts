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

import type { WordTiming } from "./interaction-policy.js";
import type { EndpointingOwner, SttReconfigurePartial } from "./plugin-contract.js";

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
  readonly component: "stt" | "tts" | "vad" | "eos" | "denoiser" | "llm" | "bridge" | "pipeline" | "iu_ledger";
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
// Audio format contract
// =============================================================================

export interface AudioFormat {
  readonly encoding: "pcm_s16le" | "mulaw" | "opus";
  readonly sampleRateHz: number;
  readonly channels: 1;
  /** Target frame duration for paced output, when known. */
  readonly frameDurationMs?: number;
}

// =============================================================================
// Input Pipeline Packets (user audio → transcript)
// =============================================================================

export interface UserAudioReceivedPacket extends VoicePacket {
  readonly kind: "user.audio_received";
  /** Raw PCM audio (16-bit, mono). Rate given by `sampleRateHz` (defaults to 16kHz). */
  readonly audio: Uint8Array;
  /** Sample rate of `audio` in Hz. Omitted means 16000 (the legacy default). */
  readonly sampleRateHz?: number;
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

// Producers: local VAD plugins (silero-vad, pipecat-smart-turn) AND provider STT
// plugins that surface a native speech-start signal (e.g. Deepgram vad_events
// SpeechStarted, Deepgram Flux StartOfTurn). Provider-agnostic by design: any STT
// plugin with an equivalent event should emit this packet so barge-in works on
// VAD-less deployments. The TurnArbiter treats all producers identically.
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

export interface SttPartialPacket extends VoicePacket {
  readonly kind: "stt.partial";
  readonly text: string;
  readonly wordTimings?: readonly WordTiming[];
}

export interface SttResultPacket extends VoicePacket {
  readonly kind: "stt.result";
  readonly text: string;
  readonly confidence: number;
  readonly language?: string;
  readonly provider?: Record<string, unknown>;
}

/** Requests that a streaming STT plugin publish its accumulated final transcript. */
export interface FinalizeSttPacket extends VoicePacket {
  readonly kind: "stt.finalize";
}

/**
 * Per-turn STT reconfigure actuation. Session routes to the stt plugin's
 * `sttReconfigure` seam when present (warn-and-no-op otherwise).
 * Call at a turn boundary so reconnect-based STTs do not drop mid-utterance audio.
 */
export interface SttReconfigurePacket extends VoicePacket {
  readonly kind: "stt.reconfigure";
  readonly partial: SttReconfigurePartial;
}

export interface SttErrorPacket extends VoicePacket, VoiceErrorPacket {
  readonly kind: "stt.error";
  readonly component: "stt";
}

export interface EndOfSpeechAudioPacket extends VoicePacket {
  readonly kind: "eos.audio";
  readonly audio: Uint8Array;
}

/**
 * Who decided a turn ended. Extends {@link EndpointingOwner} with the two
 * non-plugin regimes: `"timer"` (a realtime front owns its own turn
 * detection) and `"text"` (the user typed — no endpointer fired at all).
 *
 * Absent means genuinely unknown: never fabricate an owner the backend did
 * not measure. A debugging surface that guesses is worse than one that says so.
 */
export type TurnEndOwner = EndpointingOwner | "timer" | "text";

/**
 * Why a turn ended, paired with {@link TurnEndOwner}.
 * - `end_of_speech` — an endpointer marked natural end of speech.
 * - `force_finalized` — the STT was force-finalized by the
 *   `sttForceFinalizeTimeoutMs` watchdog (a timeout), not a natural endpoint.
 * - `typed` — the turn came from typed input; no speech was endpointed.
 */
export type TurnEndReason = "end_of_speech" | "force_finalized" | "typed";

export interface EndOfSpeechPacket extends VoicePacket {
  readonly kind: "eos.turn_complete";
  readonly text: string;
  /** All accumulated STT transcripts for this turn. */
  readonly transcripts: readonly SttResultPacket[];
  /** Which owner decided the turn ended. Omitted when genuinely unknown. */
  readonly endpointingOwner?: TurnEndOwner;
  /** Why the turn ended. Omitted when genuinely unknown. */
  readonly endpointingReason?: TurnEndReason;
}

export interface InterimEndOfSpeechPacket extends VoicePacket {
  readonly kind: "eos.interim";
  readonly text: string;
}

/**
 * Retraction of a prior `eos.interim` for the same context: the endpoint model
 * signalled a likely turn end, then the user kept speaking (Deepgram Flux
 * `TurnResumed` semantics). Consumers doing speculative work off `eos.interim`
 * must cancel it.
 */
export interface EndOfSpeechRetractedPacket extends VoicePacket {
  readonly kind: "eos.retracted";
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

export type InterruptionSource = "vad" | "word" | "client";

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

export type DtmfDigit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "*" | "#";

export interface DtmfReceivedPacket extends VoicePacket {
  readonly kind: "dtmf.received";
  readonly digit: DtmfDigit;
  readonly provider: "twilio" | "telnyx" | "smartpbx";
  /** Raw carrier-reported digit string, for diagnostics. */
  readonly rawDigit: string;
}

/**
 * Outbound DTMF request (IVR navigation). Digits may include pause syntax
 * `w` (0.5s) / `W` (1s). Mechanism unit-tested; live carrier decode unverified.
 */
export interface DtmfSendPacket extends VoicePacket {
  readonly kind: "dtmf.send";
  /** Digits in `[0-9*#wW]+`. */
  readonly digits: string;
}

export type CallTransferMode = "warm" | "cold" | "sip_refer";

/**
 * Outbound call transfer. Prefer Call-Control transfer over SIP REFER where
 * answer-rate matters (REFER drops STIR/SHAKEN attestation). Mechanism
 * unit-tested; live transfer bridge unverified against a carrier.
 */
export interface CallTransferPacket extends VoicePacket {
  readonly kind: "call.transfer";
  readonly mode: CallTransferMode;
  /** E.164 number or SIP URI. */
  readonly target: string;
  /** Warm-handoff context for the receiving agent/human (mode `"warm"`). */
  readonly summary?: string;
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
  readonly component: "llm" | "bridge" | "iu_ledger";
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

/**
 * The wire form of a `client-message` ReasoningPart — a tool-authored payload for
 * the client UI, ordered against `llm.delta` on the same route. NEVER consumed by
 * the TTS path; only `voice-agent-session`'s LLM handlers read this kind.
 */
export interface LlmClientMessagePacket extends VoicePacket {
  readonly kind: "llm.client_message";
  readonly payload: unknown;
}

export interface ReasoningSuspendedPacket extends VoicePacket {
  readonly kind: "reasoning.suspended";
  readonly runId: string;
  readonly prompt?: string;
  readonly payload: unknown;
}

// =============================================================================
// Delegate (Responder-Thinker) observability packets (Background route)
// =============================================================================

/**
 * The bridge handed a query to the Reasoner. Emitted the moment the delegate
 * turn starts (RealtimeBridge `runDelegate`) or the cascade turn reaches the
 * reasoner (ReasoningBridge), BEFORE the stream runs. Background route:
 * droppable, never blocks the hot path (RFC bimodel-delegate-seam R4).
 * `toolId`/`toolName` are present on realtime delegate turns (the front-model
 * tool call that triggered the delegate); absent on cascade turns.
 */
export interface DelegateQueryPacket extends VoicePacket {
  readonly kind: "delegate.query";
  readonly query: string;
  readonly toolId?: string;
  readonly toolName?: string;
}

/**
 * The Reasoner produced the turn's final answer. Self-contained: carries the
 * `query` again so a consumer can log/persist the Q&A pair from this one packet
 * without correlating against the earlier `delegate.query`. `durationMs` spans
 * query → answer; `grounded` is true when the reasoner stream surfaced at least
 * one `tool-result` part (e.g. a retrieval hit) while producing the answer.
 */
export interface DelegateResultPacket extends VoicePacket {
  readonly kind: "delegate.result";
  readonly query: string;
  readonly answer: string;
  readonly durationMs: number;
  readonly grounded: boolean;
  readonly toolId?: string;
  readonly toolName?: string;
  readonly control?: {
    readonly name: string;
    readonly payload: unknown;
  };
  readonly blocked?: {
    readonly userFacingMessage: string;
    readonly payload?: unknown;
  };
}

export interface ReasoningResumePacket extends VoicePacket {
  readonly kind: "reasoning.resume";
  readonly runId: string;
  readonly data: unknown;
}

/**
 * G4: a realtime provider with native session resume (Gemini Live) issued a new
 * resumption handle. Background route; a durable host (e.g. cf-agents) persists
 * the latest handle and passes it back on reconnect instead of replaying history.
 */
export interface RealtimeResumptionHandlePacket extends VoicePacket {
  readonly kind: "realtime.resumption_handle";
  readonly handle: string;
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
  readonly provider?: Record<string, unknown>;
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
/** First paced audio frame reached the wire for a context (unthrottled). */
export interface TextToSpeechPlayoutStartedPacket extends VoicePacket {
  readonly kind: "tts.playout_started";
}

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
// Interaction Policy Packets
// =============================================================================

/** Pre-cached backchannel cue id rendered by the outbound mixer (IP-C3). */
export interface InteractionBackchannelPacket extends VoicePacket {
  readonly kind: "interaction.backchannel";
  readonly cue: string;
}

/** Signal to attenuate active TTS while a barge-in is being evaluated (pending window). */
export interface InteractionDuckPacket extends VoicePacket {
  readonly kind: "interaction.duck";
}

/** Signal to restore attenuated TTS when the pending window resolved without an interrupt. */
export interface InteractionResumePacket extends VoicePacket {
  readonly kind: "interaction.resume";
}

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
  /** Defaults to speak for compatibility with existing inject.message producers. */
  readonly mode?: "speak" | "context";
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

export type AcousticSignal =
  | "prosody"
  | "backchannel"
  | "interruption"
  | "primary_speaker"
  | "echo_rejected"
  | "cadence";

export interface AcousticSignalPacket extends VoicePacket {
  readonly kind: "acoustic.signal";
  readonly signal: AcousticSignal;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export type TurnLocalizationVerdict = "infrastructure" | "conversation" | "none";

export interface TurnLocalizationPacket extends VoicePacket {
  readonly kind: "turn.localization";
  readonly value: TurnLocalizationVerdict;
  readonly infrastructureBreached: boolean;
  readonly conversationFlagged: boolean;
}

/** The pipeline stage that consumed resources. Billing planes group cost by this. */
export type UsageStage = "llm" | "stt" | "tts";

/**
 * One unit of billable resource consumption, recorded where it happens.
 *
 * The full shape is defined up front — LLM tokens, STT audio-seconds, TTS characters —
 * so a producer added later needs no schema change; only the LLM producer is wired today
 * (the AI SDK finish part carries usage the bridge had been dropping). `VoiceAgentSession`
 * accumulates these into an end-of-session `session.usage` manifest and exports them as
 * counters — the load-bearing seam for metering, spend caps, and eventual per-tenant billing.
 * Fields not applicable to a stage are simply absent (tokens on STT/TTS, seconds on LLM).
 */
export interface UsageRecordedPacket extends VoicePacket {
  readonly kind: "usage.recorded";
  readonly stage: UsageStage;
  readonly provider?: string;
  readonly model?: string;
  // LLM
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cachedInputTokens?: number;
  readonly reasoningTokens?: number;
  // STT / TTS
  readonly audioSeconds?: number;
  readonly characters?: number;
}

/**
 * A history compaction transition (RFC: Continuous-interaction architecture §2.4/§4
 * L3) — replaces the bare trimHistory() slice with an observable managed swap.
 * `started` fires synchronously when the high-water mark trips; `committed` fires
 * once the summarized prefix has been swapped in for the next turn, carrying the
 * message-count before/after. Absent `afterMessages` on `committed` means the
 * compaction was superseded (e.g. the hard `maxHistoryTurns` backstop trimmed the
 * same history first) and no swap landed.
 */
export interface HistoryCompactionPacket extends VoicePacket {
  readonly kind: "history_compaction";
  readonly phase: "started" | "committed";
  readonly beforeMessages: number;
  readonly afterMessages?: number;
}

export type TurnBoundaryKind =
  | "user_started_speaking"
  | "user_stopped_speaking"
  | "agent_thinking"
  | "agent_started_speaking"
  | "agent_audio_done"
  | "interruption";

export interface TurnBoundaryEventPacket extends VoicePacket {
  readonly kind: "obs.turn_boundary";
  readonly boundary: TurnBoundaryKind;
  readonly sessionId: string;
  readonly speechId: string;
  readonly requestId?: string;
  /** Monotonic ms (performance.timeOrigin + performance.now()) — immune to wall-clock jumps. */
  readonly monotonicMs: number;
  readonly provider?: string;
  readonly model?: string;
  readonly region?: string;
  readonly cancelled?: boolean;
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
  | SttPartialPacket
  | SttResultPacket
  | FinalizeSttPacket
  | SttReconfigurePacket
  | SttErrorPacket
  | EndOfSpeechAudioPacket
  | EndOfSpeechPacket
  | InterimEndOfSpeechPacket
  | EndOfSpeechRetractedPacket
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
  | LlmToolResultPacket
  | LlmClientMessagePacket
  | ReasoningSuspendedPacket
  | ReasoningResumePacket;

/** All TTS output packets. */
export type TtsPacket =
  | TextToSpeechTextPacket
  | TextToSpeechDonePacket
  | TextToSpeechAudioPacket
  | TextToSpeechEndPacket
  | TextToSpeechPlayoutStartedPacket
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

/** Observability packets (Background route). */
export type ObservabilityPacket =
  | ConversationMetricPacket
  | TurnBoundaryEventPacket
  | UsageRecordedPacket
  | AcousticSignalPacket
  | TurnLocalizationPacket
  | HistoryCompactionPacket;

/** Delegate (Responder-Thinker) lifecycle packets (Background route). */
export type DelegatePacket = DelegateQueryPacket | DelegateResultPacket;
