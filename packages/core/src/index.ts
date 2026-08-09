// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Public API
//
// Everything a consumer needs to build voice agents with the new kernel.

// Core types
export {
  type AudioFormat,
  type VoicePacket,
  type AsyncPacket,
  type VoiceErrorPacket,
  ErrorCategory,
  SessionState,
  InitStage,
  type InitStepCompletedPacket,
  type InitializationFailedPacket,
  type InitializationCompletedPacket,
} from "./packets.js";

// Pipeline packets — input
export {
  type UserAudioReceivedPacket,
  type UserTextReceivedPacket,
  type DenoiseAudioPacket,
  type DenoisedAudioPacket,
  type VadAudioPacket,
  type VadSpeechStartedPacket,
  type VadSpeechEndedPacket,
  type VadSpeechActivityPacket,
  type SpeechToTextAudioPacket,
  type SttInterimPacket,
  type SttPartialPacket,
  type SttResultPacket,
  type FinalizeSttPacket,
  type SttReconfigurePacket,
  type SttErrorPacket,
  type EndOfSpeechAudioPacket,
  type EndOfSpeechPacket,
  type InterimEndOfSpeechPacket,
  type EndOfSpeechRetractedPacket,
  type TurnEndOwner,
  type TurnEndReason,
  type UserInputPacket,
} from "./packets.js";

// Pipeline packets — interruption
export {
  type InterruptionDetectedPacket,
  type InterruptTtsPacket,
  type InterruptLlmPacket,
  type InterruptSttPacket,
  type TurnChangePacket,
} from "./packets.js";

// Telephony control packets (DTMF / transfer)
export {
  type DtmfDigit,
  type DtmfReceivedPacket,
  type DtmfSendPacket,
  type CallTransferMode,
  type CallTransferPacket,
} from "./packets.js";
export { parseDtmfDigit, dtmfReceived, dtmfSend, callTransfer } from "./packet-factories.js";

// Pipeline packets — LLM
export {
  type LlmDeltaPacket,
  type LlmResponseDonePacket,
  type LlmErrorPacket,
  type LlmToolCallPacket,
  type LlmToolResultPacket,
} from "./packets.js";

// Pipeline packets — reasoning (suspend/resume)
export {
  type ReasoningSuspendedPacket,
  type ReasoningResumePacket,
} from "./packets.js";

// Pipeline packets — delegate (Responder-Thinker) observability
export {
  type DelegateQueryPacket,
  type DelegateResultPacket,
  type DelegatePacket,
  type RealtimeResumptionHandlePacket,
} from "./packets.js";

// Durable reasoner session state (G4)
export {
  InMemoryReasonerSessionStore,
  type ReasonerSessionStore,
} from "./reasoner-session-store.js";

// Incremental-Unit ledger (IU substrate — dormant until C2)
export {
  type IuState,
  type IncrementalUnitId,
  type IncrementalUnit,
} from "./incremental-unit.js";
export {
  type IuLedger,
  type IuLedgerAnomaly,
  InMemoryIuLedger,
} from "./iu-ledger.js";
export {
  IU_LEDGER_CONFIG_KEY,
  isIuLedger,
  TurnSegmentation,
  type TranscriptMessage,
  type TranscriptViews,
} from "./iu-segmentation.js";
export {
  applyCommittedPrefix,
  formatTranscriptIuId,
} from "./transcript-views.js";

// Pipeline packets — TTS
export {
  type TextToSpeechTextPacket,
  type TextToSpeechDonePacket,
  type TextToSpeechAudioPacket,
  type TextToSpeechEndPacket,
  type TextToSpeechPlayoutStartedPacket,
  type TextToSpeechPlayoutProgressPacket,
  type TextToSpeechWordTimestampsPacket,
  type TtsWordTimestamp,
  type TtsErrorPacket,
} from "./packets.js";

// Pipeline packets — behavior
export {
  type RecordAssistantAudioDataPacket,
  type RecordAssistantAudioPacket,
  type RecordAssistantAudioTruncatePacket,
  type RecordUserAudioPacket,
  type StartIdleTimeoutPacket,
  type StopIdleTimeoutPacket,
  type InjectMessagePacket,
  type DisconnectRequestedPacket,
} from "./packets.js";

// Pipeline packets — mode
export {
  type ModeSwitchRequestedPacket,
  type ModeSwitchCompletedPacket,
} from "./packets.js";

// Pipeline packets — persistence
export {
  type MessageCreatePacket,
  type ConversationMetricPacket,
  type AcousticSignalPacket,
  type AcousticSignal,
  type TurnLocalizationPacket,
  type UsageStage,
  type UsageRecordedPacket,
  type TurnBoundaryKind,
  type TurnBoundaryEventPacket,
  type ObservabilityPacket,
  type PipelineErrorPacket,
} from "./packets.js";

// Metering: price catalog + spend-cap guard (standalone; session wires later)
export {
  type SttPrice,
  type LlmPrice,
  type TtsPrice,
  type PriceCatalog,
  type CostResult,
  DEFAULT_PRICE_CATALOG,
  costOf,
} from "./pricing.js";
export {
  SpendCapGuard,
  type SpendCapConfig,
  type SpendCapCheck,
} from "./spend-cap.js";

// Observability backbone (VE-07)
export {
  monotonicNowMs,
  type MetricTags,
  type ObservabilityLayer,
  type TurnLocalizationVerdict,
  type TurnLocalizationSignals,
  localizeTurn,
  type SpanHandle,
  type MetricsExporter,
  noopMetricsExporter,
  InMemoryMetricsExporter,
  reconstructTurnTimeline,
  type TurnTimelineStep,
} from "./observability.js";

export {
  ObservabilityObserver,
  type ObservabilityObserverDeps,
  type ObservabilityDims,
} from "./observability-observer.js";

// PipelineBus
export {
  PipelineBusImpl,
  Route,
  MEDIA_KINDS,
  type PipelineBus,
  type PipelineBusConfig,
  type PacketHandler,
} from "./pipeline-bus.js";

// Init chain
export { runInitChain, runFinalizeChain, type InitStep, InitializationError } from "./init-chain.js";

// Plugin contract
export {
  type VoicePlugin,
  type PluginConfig,
  type EndpointingOwner,
  type EndpointingCapability,
  type SttReconfigure,
  type SttReconfigurePartial,
  requireStringConfig,
  optionalStringConfig,
} from "./plugin-contract.js";

// Error handler
export { categorizeSttError, categorizeTtsError, categorizeLlmError, isRecoverable, isFatalError } from "./error-handler.js";

// Retry helpers
export { DEFAULT_RETRY_CONFIG, VOICE_PROVIDER_RETRY_CONFIG, VOICE_PROVIDER_OUTAGE_RETRY_CONFIG, readRetryConfig, readProviderRetryConfig, retryDelayMs, waitForRetryDelay, type RetryConfig } from "./retry.js";

// Provider fallback/degradation
export { ProviderFallback, type FallbackProvider, type ProviderFallbackOptions } from "./provider-fallback.js";

// Runtime scheduler seam
export { TimerScheduler, type Scheduler, type ScheduledCallback } from "./scheduler.js";

// Idle timeout
export { IdleTimeoutManager, type IdleTimeoutConfig, DEFAULT_IDLE_TIMEOUT_CONFIG } from "./idle-timeout.js";

// Mode switcher
export { ModeSwitcher, type ModeSwitchHandlers } from "./mode-switcher.js";

// Conversation events
export { type ConversationEvent, createConversationEventStream } from "./conversation-event.js";

// Websocket audio envelope
export {
  SYRINX_AUDIO_ENVELOPE_NAME,
  SYRINX_AUDIO_ENVELOPE_MAGIC,
  assertAudioFormat,
  assertAudioPayload,
  encodeSyrinxAudioEnvelope,
  decodeSyrinxAudioEnvelope,
  hasSyrinxAudioEnvelope,
  type SyrinxAudioEnvelope,
  type SyrinxAudioEnvelopeHeader,
} from "./audio-envelope.js";

export {
  StreamingPcm16Resampler,
  createLoudnessState,
  normalizeLoudness,
  type LoudnessConfig,
  type LoudnessState,
} from "./audio/index.js";

// Interaction policy seam (IP-C1)
export {
  type InteractionPolicy,
  type LifecycleInteractionPolicy,
  isLifecycleInteractionPolicy,
  type InteractionObservation,
  type InteractionDecision,
  type AcousticSignalObservation,
  type AcousticSignalSink,
  type WordTiming,
} from "./interaction-policy.js";
export { confidenceToWaitMs, type ConfidenceToWaitConfig } from "./confidence-to-wait.js";
export { RuleBasedInteractionPolicy } from "./policies/rule-based.js";
export { DeferInteractionPolicy } from "./policies/defer.js";
export { InteractionCoordinator, type InteractionCaps } from "./interaction-coordinator.js";
export {
  type InteractionBackchannelPacket,
  type InteractionDuckPacket,
  type InteractionResumePacket,
} from "./packets.js";

// VoiceAgentSession
export {
  VoiceAgentSession,
  type VoiceAgentSessionConfig,
  type VoiceAgentSessionEvents,
  type SessionStartBoundaries,
  type SessionStageUsage,
} from "./voice-agent-session.js";

// Primary-speaker barge-in gate (VE-02)
export {
  PrimarySpeakerGate,
  extractSpeakerFingerprint,
  fingerprintSimilarity,
  type SpeakerFingerprint,
  type PrimarySpeakerGateDecision,
  type PrimarySpeakerGateConfig,
} from "./primary-speaker-gate.js";
export {
  synthesizeTonePcm16,
  mixPcm16,
  PRIMARY_SPEAKER_TONE_HZ,
  BYSTANDER_SPEAKER_TONE_HZ,
  ASSISTANT_ECHO_TONE_HZ,
} from "./primary-speaker-fixtures.js";

// Latency-hiding filler track (VE-03)
export {
  LatencyFillerController,
  selectLatencyFillerConnective,
  stripRedundantFillerPrefix,
  LATENCY_FILLER_CONNECTIVES,
  type LatencyFillerConfig,
  type LatencyFillerState,
  type LatencyFillerConnective,
} from "./latency-filler.js";
export {
  LATENCY_FILLER_FIXTURES,
  type LatencyFillerFixture,
} from "./latency-filler-fixtures.js";

// Voice text: markdown/formatting normalization + leaked-tool-call guard before TTS
export { normalizeForSpeech, stripLeakedToolCalls } from "./voice-text.js";

// Reasoner seam (RFC §4.2)
export {
  type Reasoner,
  type ReasonerCapabilities,
  type ComposedReasoner,
  type ReasonerPrewarmContext,
  type ReasonerTurn,
  type ReasonerMessage,
  type ReasonerUsage,
  type ReasoningPart,
} from "./reasoner.js";

// Hedged reasoner (Lever C — reasoner-latency RFC)
export { HedgedReasoner, type HedgedReasonerOptions } from "./reasoner-hedge.js";

// Routing reasoner (Lever B — reasoner-latency RFC)
export {
  RoutingReasoner,
  type RoutingReasonerOptions,
  type ReasonerRoute,
} from "./reasoner-route.js";
