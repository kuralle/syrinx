// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Packet Factories
//
// Typed constructors for the packets the session orchestrator pushes onto the
// bus. Each returns a fully-typed packet, so the shape is checked at the factory
// definition and call sites need no `as` assertion — illegal packet shapes are
// unrepresentable at construction instead of asserted-valid by a cast (CR-05).

import { ErrorCategory } from "./packets.js";
import type {
  ConversationMetricPacket,
  DtmfDigit,
  DtmfReceivedPacket,
  RecordUserAudioPacket,
  RecordAssistantAudioDataPacket,
  RecordAssistantAudioTruncatePacket,
  VadAudioPacket,
  SpeechToTextAudioPacket,
  EndOfSpeechAudioPacket,
  EndOfSpeechPacket,
  SttResultPacket,
  UserInputPacket,
  TextToSpeechTextPacket,
  TextToSpeechDonePacket,
  TtsErrorPacket,
  InterruptionDetectedPacket,
  InterruptionSource,
  InterruptTtsPacket,
  InterruptLlmPacket,
  InjectMessagePacket,
  LlmDeltaPacket,
  LlmResponseDonePacket,
  StartIdleTimeoutPacket,
  StopIdleTimeoutPacket,
  ModeSwitchRequestedPacket,
} from "./packets.js";

const DTMF_DIGITS = new Set<DtmfDigit>(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "#"]);

export function parseDtmfDigit(raw: string): DtmfDigit | null {
  const trimmed = raw.trim();
  if (trimmed.length !== 1 || !DTMF_DIGITS.has(trimmed as DtmfDigit)) return null;
  return trimmed as DtmfDigit;
}

export function dtmfReceived(
  contextId: string,
  timestampMs: number,
  digit: DtmfDigit,
  provider: DtmfReceivedPacket["provider"],
  rawDigit: string,
): DtmfReceivedPacket {
  return { kind: "dtmf.received", contextId, timestampMs, digit, provider, rawDigit };
}

export function metric(
  contextId: string,
  name: string,
  value: string,
  timestampMs: number = Date.now(),
): ConversationMetricPacket {
  return { kind: "metric.conversation", contextId, timestampMs, name, value };
}

export function recordUserAudio(
  contextId: string,
  timestampMs: number,
  audio: Uint8Array,
): RecordUserAudioPacket {
  return { kind: "record.user_audio", contextId, timestampMs, audio };
}

export function vadAudio(contextId: string, timestampMs: number, audio: Uint8Array): VadAudioPacket {
  return { kind: "vad.audio", contextId, timestampMs, audio };
}

export function sttAudio(contextId: string, timestampMs: number, audio: Uint8Array): SpeechToTextAudioPacket {
  return { kind: "stt.audio", contextId, timestampMs, audio };
}

export function eosAudio(contextId: string, timestampMs: number, audio: Uint8Array): EndOfSpeechAudioPacket {
  return { kind: "eos.audio", contextId, timestampMs, audio };
}

export function eosTurnComplete(
  contextId: string,
  timestampMs: number,
  text: string,
  transcripts: readonly SttResultPacket[],
): EndOfSpeechPacket {
  return { kind: "eos.turn_complete", contextId, timestampMs, text, transcripts };
}

export function userInput(
  contextId: string,
  timestampMs: number,
  text: string,
  language: string,
): UserInputPacket {
  return { kind: "user.input", contextId, timestampMs, text, language };
}

export function ttsText(contextId: string, timestampMs: number, text: string): TextToSpeechTextPacket {
  return { kind: "tts.text", contextId, timestampMs, text };
}

export function ttsDone(contextId: string, timestampMs: number, text: string): TextToSpeechDonePacket {
  return { kind: "tts.done", contextId, timestampMs, text };
}

export function recordAssistantAudio(
  contextId: string,
  timestampMs: number,
  audio: Uint8Array,
  sampleRateHz: number,
): RecordAssistantAudioDataPacket {
  return { kind: "record.assistant_audio", contextId, timestampMs, audio, sampleRateHz, truncate: false };
}

export function recordAssistantTruncate(
  contextId: string,
  timestampMs: number,
): RecordAssistantAudioTruncatePacket {
  return { kind: "record.assistant_audio", contextId, timestampMs, audio: new Uint8Array(0), truncate: true };
}

export function interruptDetected(
  contextId: string,
  timestampMs: number,
  source: InterruptionSource,
): InterruptionDetectedPacket {
  return { kind: "interrupt.detected", contextId, timestampMs, source };
}

export function interruptTts(contextId: string, timestampMs: number): InterruptTtsPacket {
  return { kind: "interrupt.tts", contextId, timestampMs };
}

export function interruptLlm(contextId: string, timestampMs: number): InterruptLlmPacket {
  return { kind: "interrupt.llm", contextId, timestampMs };
}

export function ttsError(
  contextId: string,
  timestampMs: number,
  cause: Error,
  category: ErrorCategory,
  isRecoverable: boolean,
): TtsErrorPacket {
  return { kind: "tts.error", contextId, timestampMs, component: "tts", category, cause, isRecoverable };
}

export function injectMessage(contextId: string, timestampMs: number, text: string): InjectMessagePacket {
  return { kind: "inject.message", contextId, timestampMs, text };
}

export function llmDelta(contextId: string, timestampMs: number, text: string): LlmDeltaPacket {
  return { kind: "llm.delta", contextId, timestampMs, text };
}

export function llmDone(contextId: string, timestampMs: number, text: string): LlmResponseDonePacket {
  return { kind: "llm.done", contextId, timestampMs, text };
}

export function startIdleTimeout(contextId: string, timestampMs: number): StartIdleTimeoutPacket {
  return { kind: "behavior.idle_timeout_start", contextId, timestampMs };
}

export function stopIdleTimeout(
  contextId: string,
  timestampMs: number,
  resetCount: boolean,
): StopIdleTimeoutPacket {
  return { kind: "behavior.idle_timeout_stop", contextId, timestampMs, resetCount };
}

export function modeSwitchRequested(
  contextId: string,
  timestampMs: number,
  mode: "text" | "audio",
): ModeSwitchRequestedPacket {
  return { kind: "mode.switch_requested", contextId, timestampMs, mode };
}
