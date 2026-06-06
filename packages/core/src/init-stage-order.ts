// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Init Stage Ordering
//
// Pure mapping from plugin name → init stage, and the deterministic order in
// which stages initialize (and, reversed, finalize). Extracted from
// VoiceAgentSession so the orchestrator owns chain assembly, not the ordering
// policy.

import { InitStage } from "./packets.js";

export function pluginStage(name: string): InitStage {
  switch (name) {
    case "stt":
    case "deepgram":
      return InitStage.STT;
    case "tts":
    case "cartesia":
    case "elevenlabs":
      return InitStage.TTS;
    case "vad":
    case "silero":
      return InitStage.VAD;
    case "eos":
    case "pipecat":
      return InitStage.EOS;
    case "denoiser":
    case "rnnoise":
      return InitStage.Denoiser;
    case "bridge":
    case "aisdk":
      return InitStage.Assistant;
    case "recorder":
      return InitStage.Recorder;
    case "auth":
      return InitStage.Auth;
    default:
      return InitStage.Assistant;
  }
}

export function stageOrder(stage: InitStage): number {
  switch (stage) {
    case InitStage.Assistant:
      return 10;
    case InitStage.Conversation:
      return 20;
    case InitStage.Recorder:
      return 30;
    case InitStage.Normalizer:
      return 40;
    case InitStage.Auth:
      return 50;
    case InitStage.STT:
      return 60;
    case InitStage.TTS:
      return 70;
    case InitStage.VAD:
      return 80;
    case InitStage.EOS:
      return 90;
    case InitStage.Denoiser:
      return 100;
    case InitStage.Behavior:
      return 110;
    case InitStage.Telemetry:
      return 120;
  }
}

export function isAudioStage(stage: InitStage): boolean {
  return (
    stage === InitStage.STT ||
    stage === InitStage.TTS ||
    stage === InitStage.VAD ||
    stage === InitStage.EOS ||
    stage === InitStage.Denoiser
  );
}
