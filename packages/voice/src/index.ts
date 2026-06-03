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
  type SttResultPacket,
  type FinalizeSttPacket,
  type SttErrorPacket,
  type EndOfSpeechAudioPacket,
  type EndOfSpeechPacket,
  type InterimEndOfSpeechPacket,
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

// Pipeline packets — LLM
export {
  type LlmDeltaPacket,
  type LlmResponseDonePacket,
  type LlmErrorPacket,
  type LlmToolCallPacket,
  type LlmToolResultPacket,
} from "./packets.js";

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
  type PipelineErrorPacket,
} from "./packets.js";

// PipelineBus
export { PipelineBusImpl, Route, type PipelineBus, type PipelineBusConfig, type PacketHandler } from "./pipeline-bus.js";

// Init chain
export { runInitChain, runFinalizeChain, type InitStep, InitializationError } from "./init-chain.js";

// Plugin contract
export { type VoicePlugin, type PluginConfig, requireStringConfig, optionalStringConfig } from "./plugin-contract.js";

// Error handler
export { categorizeSttError, categorizeTtsError, categorizeLlmError, isRecoverable, isFatalError } from "./error-handler.js";

// Retry helpers
export { DEFAULT_RETRY_CONFIG, readRetryConfig, retryDelayMs, waitForRetryDelay, type RetryConfig } from "./retry.js";

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

// VoiceAgentSession
export { VoiceAgentSession, type VoiceAgentSessionConfig, type VoiceAgentSessionEvents } from "./voice-agent-session.js";

// Primary-speaker barge-in gate (VE-02)
export {
  PrimarySpeakerGate,
  extractSpeakerFingerprint,
  fingerprintSimilarity,
  type SpeakerFingerprint,
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
