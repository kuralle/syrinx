// SPDX-License-Identifier: MIT

import {
  type ConversationMetricPacket,
  type EndOfSpeechPacket,
  type InterruptTtsPacket,
  type LlmDeltaPacket,
  type PipelineBus,
  type SttResultPacket,
  type TextToSpeechAudioPacket,
  type TextToSpeechEndPacket,
  type TextToSpeechPlayoutProgressPacket,
  type TextToSpeechPlayoutStartedPacket,
  type VadSpeechEndedPacket,
} from "@kuralle-syrinx/core";

export interface TurnTimestampState {
  speechEndMs: number;
  sttFinalMs: number;
  eosMs: number;
  vadStopHangoverMs: number;
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
  readonly eouBudgetMs?: {
    readonly vadStopHangoverMs?: number;
    readonly sttFinalDelayMs?: number;
    readonly endpointDelayMs?: number;
    readonly totalMs?: number;
  };
}

/**
 * The field set `buildBrowserMetricsMessage` populates for an audio-originated turn
 * (`vad.speech_ended` + `stt.result` + `llm.delta` + `tts.audio` all measured) —
 * everything EXCEPT `firstAudioPlayedMs`/`lastAudioPlayedMs`, which depend on a
 * playout-completion signal whose *source* legitimately differs per transport
 * (Node's browser websocket path paces server-side; the Workers/DO edge path is
 * client-paced). Both runtimes call this same builder and must emit this same core
 * set; the parity tests in both packages assert against this constant so a runtime
 * that silently drops the `metrics` message, or diverges in shape, fails loudly.
 */
export const CORE_METRICS_FIELDS = [
  "type",
  "turnId",
  "correlationId",
  "speechEndMs",
  "textReadyMs",
  "firstAudioByteMs",
  "sttMs",
  "llmTTFTMs",
  "ttsTTFBMs",
  "e2eMs",
  "eouBudgetMs",
] as const;

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

  const sttFinalDelayMs = positiveDelta(timestamps.sttFinalMs, timestamps.speechEndMs);
  const endpointDelayMs = positiveDelta(timestamps.eosMs, timestamps.sttFinalMs);
  const vadStopHangoverMs =
    timestamps.vadStopHangoverMs > 0 ? timestamps.vadStopHangoverMs : undefined;
  const eouTotalMs =
    (vadStopHangoverMs ?? 0) +
      (positiveDelta(timestamps.eosMs, timestamps.speechEndMs) ?? sttFinalDelayMs ?? 0) ||
    undefined;
  const eouBudgetMs =
    vadStopHangoverMs !== undefined ||
    sttFinalDelayMs !== undefined ||
    endpointDelayMs !== undefined ||
    eouTotalMs !== undefined
      ? {
          ...(vadStopHangoverMs !== undefined ? { vadStopHangoverMs } : {}),
          ...(sttFinalDelayMs !== undefined ? { sttFinalDelayMs } : {}),
          ...(endpointDelayMs !== undefined ? { endpointDelayMs } : {}),
          ...(eouTotalMs !== undefined ? { totalMs: eouTotalMs } : {}),
        }
      : undefined;

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
    ...(eouBudgetMs !== undefined ? { eouBudgetMs } : {}),
  };
}

function emptyTurnState(): TurnTimestampState {
  return {
    speechEndMs: 0,
    sttFinalMs: 0,
    eosMs: 0,
    vadStopHangoverMs: 0,
    textReadyMs: 0,
    firstAudioByteMs: 0,
    firstAudioPlayedMs: 0,
    lastAudioPlayedMs: 0,
  };
}

export interface TurnMetricsTrackerOptions {
  /**
   * Additionally finalize (emit + clear) a turn's metrics on `tts.end` when no
   * `tts.playout_progress` completion has arrived yet. The Node browser websocket
   * path always gets a `tts.playout_progress` completion shortly after `tts.end`
   * from its own server-side pacer (playout-progress.ts) — turning this on there
   * would race a premature, playout-less emission ahead of the real one, so it
   * defaults off and Node leaves it unset. The Workers/DO edge path is
   * client-paced (the browser reports playout over the wire); a client that never
   * reports it — a non-browser client, or a text-only smoke probe — would
   * otherwise leave a turn's metrics pending forever, so edge opts in. If a
   * richer client-reported completion arrives after this floor already fired,
   * it is a no-op: the turn was already finalized and cleared.
   */
  readonly finalizeOnTtsEnd?: boolean;
}

export class TurnMetricsTracker {
  private readonly turns: Map<string, TurnTimestampState>;

  constructor(
    private readonly bus: PipelineBus,
    private readonly onEmit: (message: BrowserMetricsMessage) => void,
    persistedTurns?: Map<string, TurnTimestampState>,
    private readonly options: TurnMetricsTrackerOptions = {},
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
      this.bus.on("metric.conversation", (pkt) => {
        const metric = pkt as ConversationMetricPacket;
        if (metric.name !== "vad.stop_hangover_ms") return;
        const hangoverMs = Number(metric.value);
        if (Number.isNaN(hangoverMs)) return;
        const state = this.turnState(metric.contextId);
        if (state.vadStopHangoverMs === 0) state.vadStopHangoverMs = hangoverMs;
      }),
      this.bus.on("eos.turn_complete", (pkt) => {
        const eos = pkt as EndOfSpeechPacket;
        const state = this.turnState(eos.contextId);
        if (state.eosMs === 0) state.eosMs = eos.timestampMs;
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
        // The edge transport never emits `tts.playout_started` — the browser reports
        // its own playout clock and that is forwarded here (edge.ts). So take the
        // first progress report as the moment audio started playing. On the Node path
        // `playout_started` has already set this, and the `=== 0` guard leaves it be.
        if (state.firstAudioPlayedMs === 0) state.firstAudioPlayedMs = progress.timestampMs;
        if (progress.complete) {
          state.lastAudioPlayedMs = progress.timestampMs;
          this.onEmit(buildBrowserMetricsMessage(progress.contextId, state));
          this.turns.delete(progress.contextId);
        }
      }),
      this.bus.on("tts.end", (pkt) => {
        if (!this.options.finalizeOnTtsEnd) return;
        const end = pkt as TextToSpeechEndPacket;
        const state = this.turns.get(end.contextId);
        if (!state) return;
        // `tts.end` means synthesis finished, which is EARLIER than playback finishing.
        // So if this client is pacing playout, firing here would emit a poorer message
        // and delete the turn before the real completion arrived — costing
        // firstAudioPlayedMs, lastAudioPlayedMs, and downgrading e2eMs from
        // "to first audio played" to "to first byte" on this runtime only. That is the
        // exact runtime drift this tracker exists to prevent.
        //
        // A non-zero firstAudioPlayedMs means playout has been reported, so wait.
        // The floor is only for clients that never report at all.
        if (state.firstAudioPlayedMs !== 0) return;
        this.onEmit(buildBrowserMetricsMessage(end.contextId, state));
        this.turns.delete(end.contextId);
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
