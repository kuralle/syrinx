// SPDX-License-Identifier: MIT

import {
  type InterruptTtsPacket,
  type LlmDeltaPacket,
  type PipelineBus,
  type SttResultPacket,
  type TextToSpeechAudioPacket,
  type TextToSpeechPlayoutProgressPacket,
  type TextToSpeechPlayoutStartedPacket,
  type VadSpeechEndedPacket,
} from "@asyncdot/voice";

export interface TurnTimestampState {
  speechEndMs: number;
  sttFinalMs: number;
  textReadyMs: number;
  firstAudioByteMs: number;
  firstAudioPlayedMs: number;
  lastAudioPlayedMs: number;
}

export interface BrowserMetricsMessage {
  readonly type: "metrics";
  readonly turnId: string;
  readonly correlationId: string;
  readonly speechEndMs?: number;
  readonly textReadyMs?: number;
  readonly firstAudioByteMs?: number;
  readonly firstAudioPlayedMs?: number;
  readonly lastAudioPlayedMs?: number;
  readonly sttMs?: number;
  readonly llmTTFTMs?: number;
  readonly ttsTTFBMs?: number;
  readonly e2eMs?: number;
}

function positiveDelta(endMs: number, startMs: number): number | undefined {
  if (endMs <= 0 || startMs <= 0 || endMs < startMs) return undefined;
  return endMs - startMs;
}

export function buildBrowserMetricsMessage(
  turnId: string,
  timestamps: TurnTimestampState,
): BrowserMetricsMessage {
  const sttMs = positiveDelta(timestamps.sttFinalMs, timestamps.speechEndMs);
  const llmTTFTMs = positiveDelta(timestamps.textReadyMs, timestamps.sttFinalMs);
  const ttsTTFBMs = positiveDelta(timestamps.firstAudioByteMs, timestamps.textReadyMs);
  const e2eFromPlayout = positiveDelta(timestamps.firstAudioPlayedMs, timestamps.speechEndMs);
  const e2eFromByte = positiveDelta(timestamps.firstAudioByteMs, timestamps.speechEndMs);

  return {
    type: "metrics",
    turnId,
    correlationId: turnId,
    ...(timestamps.speechEndMs > 0 ? { speechEndMs: timestamps.speechEndMs } : {}),
    ...(timestamps.textReadyMs > 0 ? { textReadyMs: timestamps.textReadyMs } : {}),
    ...(timestamps.firstAudioByteMs > 0 ? { firstAudioByteMs: timestamps.firstAudioByteMs } : {}),
    ...(timestamps.firstAudioPlayedMs > 0 ? { firstAudioPlayedMs: timestamps.firstAudioPlayedMs } : {}),
    ...(timestamps.lastAudioPlayedMs > 0 ? { lastAudioPlayedMs: timestamps.lastAudioPlayedMs } : {}),
    ...(sttMs !== undefined ? { sttMs } : {}),
    ...(llmTTFTMs !== undefined ? { llmTTFTMs } : {}),
    ...(ttsTTFBMs !== undefined ? { ttsTTFBMs } : {}),
    ...(e2eFromPlayout !== undefined ? { e2eMs: e2eFromPlayout } : e2eFromByte !== undefined ? { e2eMs: e2eFromByte } : {}),
  };
}

function emptyTurnState(): TurnTimestampState {
  return {
    speechEndMs: 0,
    sttFinalMs: 0,
    textReadyMs: 0,
    firstAudioByteMs: 0,
    firstAudioPlayedMs: 0,
    lastAudioPlayedMs: 0,
  };
}

export class TurnMetricsTracker {
  private readonly turns: Map<string, TurnTimestampState>;

  constructor(
    private readonly bus: PipelineBus,
    private readonly onEmit: (message: BrowserMetricsMessage) => void,
    persistedTurns?: Map<string, TurnTimestampState>,
  ) {
    this.turns = persistedTurns ?? new Map();
  }

  wire(disposers: Array<() => void>): void {
    disposers.push(
      this.bus.on("vad.speech_ended", (pkt) => {
        const ended = pkt as VadSpeechEndedPacket;
        const state = this.turnState(ended.contextId);
        if (state.speechEndMs === 0) state.speechEndMs = ended.timestampMs;
      }),
      this.bus.on("stt.result", (pkt) => {
        const result = pkt as SttResultPacket;
        const state = this.turnState(result.contextId);
        if (state.sttFinalMs === 0) state.sttFinalMs = result.timestampMs;
      }),
      this.bus.on("llm.delta", (pkt) => {
        const delta = pkt as LlmDeltaPacket;
        if (delta.text.length === 0) return;
        const state = this.turnState(delta.contextId);
        if (state.textReadyMs === 0) state.textReadyMs = delta.timestampMs;
      }),
      this.bus.on("tts.audio", (pkt) => {
        const audio = pkt as TextToSpeechAudioPacket;
        const state = this.turnState(audio.contextId);
        if (state.firstAudioByteMs === 0) state.firstAudioByteMs = audio.timestampMs;
      }),
      this.bus.on("tts.playout_started", (pkt) => {
        const started = pkt as TextToSpeechPlayoutStartedPacket;
        const state = this.turns.get(started.contextId);
        if (!state) return;
        if (state.firstAudioPlayedMs === 0) {
          state.firstAudioPlayedMs = started.timestampMs;
        }
      }),
      this.bus.on("tts.playout_progress", (pkt) => {
        const progress = pkt as TextToSpeechPlayoutProgressPacket;
        const state = this.turns.get(progress.contextId);
        if (!state) return;
        if (progress.complete) {
          state.lastAudioPlayedMs = progress.timestampMs;
          this.onEmit(buildBrowserMetricsMessage(progress.contextId, state));
          this.turns.delete(progress.contextId);
        }
      }),
      this.bus.on("interrupt.tts", (pkt) => {
        this.turns.delete((pkt as InterruptTtsPacket).contextId);
      }),
    );
  }

  private turnState(contextId: string): TurnTimestampState {
    let state = this.turns.get(contextId);
    if (!state) {
      state = emptyTurnState();
      this.turns.set(contextId, state);
    }
    return state;
  }
}
