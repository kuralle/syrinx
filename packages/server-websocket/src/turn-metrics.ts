// SPDX-License-Identifier: MIT

import {
  Route,
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
  type TurnEndOwner,
  type TurnEndReason,
  type VadSpeechEndedPacket,
  type VoiceAgentSession,
  type VoiceAgentSessionEvents,
} from "@kuralle-syrinx/core";

/** The session's `turn_latency` event, verbatim except the top-level `tsMs`/`turnId`. */
export type TurnLatencyEvent = Parameters<VoiceAgentSessionEvents["turn_latency"]>[0];

export interface TurnTimestampState {
  speechEndMs: number;
  sttFinalMs: number;
  eosMs: number;
  vadStopHangoverMs: number;
  textReadyMs: number;
  firstAudioByteMs: number;
  firstAudioPlayedMs: number;
  lastAudioPlayedMs: number;
  /** Who decided the turn ended — captured from the completing eos packet. */
  endpointingOwner?: TurnEndOwner;
  /** Why the turn ended — captured from the completing eos packet. */
  endpointingReason?: TurnEndReason;
  /** Set when the STT force-finalize watchdog fired for this turn. */
  forceFinalized?: boolean;
  /** The session's own turn_latency decomposition for this turn, once observed. */
  turnLatency?: TurnLatencyEvent;
}

export interface BrowserMetricsMessage {
  readonly type: "metrics";
  readonly turnId: string;
  readonly correlationId: string;
  // ---- copied from the session's turn_latency event, same names, same anchor ----
  readonly ttfaMs: number;
  readonly anchor: "speech_end" | "eos";
  readonly unattributedMs: number;
  readonly eouDelayMs?: number;
  readonly llmTtftMs?: number;
  readonly textAggregationMs?: number;
  readonly ttsTtfbMs?: number;
  readonly queuedMs?: number;
  readonly llmCallCount?: number;
  readonly fillerUsed?: boolean;
  readonly backchannelUsed?: boolean;
  // ---- transport-only: absolute marks and playout, which the session cannot see ----
  readonly speechEndMs?: number;
  readonly textReadyMs?: number;
  readonly firstAudioByteMs?: number;
  readonly firstAudioPlayedMs?: number;
  readonly lastAudioPlayedMs?: number;
  /** anchor → first audio PLAYED, the number a caller experiences. Omitted when playout is not reported. */
  readonly ttfaPlayedMs?: number;
  readonly eouBudgetMs?: {
    readonly vadStopHangoverMs?: number;
    readonly sttFinalDelayMs?: number;
    readonly endpointDelayMs?: number;
    readonly totalMs?: number;
  };
  /** Which owner decided the turn ended. Omitted when the backend did not say. */
  readonly endpointingOwner?: TurnEndOwner;
  /** Why the turn ended. Omitted when the backend did not say. */
  readonly endpointingReason?: TurnEndReason;
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
  "ttfaMs",
  "anchor",
  "unattributedMs",
  "speechEndMs",
  "textReadyMs",
  "firstAudioByteMs",
  "eouBudgetMs",
] as const;

function positiveDelta(endMs: number, startMs: number): number | undefined {
  if (endMs <= 0 || startMs <= 0 || endMs < startMs) return undefined;
  return endMs - startMs;
}

function buildEouBudgetMs(state: TurnTimestampState): BrowserMetricsMessage["eouBudgetMs"] {
  const sttFinalDelayMs = positiveDelta(state.sttFinalMs, state.speechEndMs);
  const endpointDelayMs = positiveDelta(state.eosMs, state.sttFinalMs);
  const vadStopHangoverMs = state.vadStopHangoverMs > 0 ? state.vadStopHangoverMs : undefined;
  const totalMs =
    (vadStopHangoverMs ?? 0) +
      (positiveDelta(state.eosMs, state.speechEndMs) ?? sttFinalDelayMs ?? 0) || undefined;

  if (
    vadStopHangoverMs === undefined &&
    sttFinalDelayMs === undefined &&
    endpointDelayMs === undefined &&
    totalMs === undefined
  ) {
    return undefined;
  }
  return {
    ...(vadStopHangoverMs !== undefined ? { vadStopHangoverMs } : {}),
    ...(sttFinalDelayMs !== undefined ? { sttFinalDelayMs } : {}),
    ...(endpointDelayMs !== undefined ? { endpointDelayMs } : {}),
    ...(totalMs !== undefined ? { totalMs } : {}),
  };
}

/** anchor → first audio PLAYED. Omitted when playout was never reported, or the anchor mark is missing. */
function computeTtfaPlayedMs(turnLatency: TurnLatencyEvent, state: TurnTimestampState): number | undefined {
  if (state.firstAudioPlayedMs <= 0) return undefined;
  const anchorTimestampMs = turnLatency.anchor === "speech_end" ? state.speechEndMs : state.eosMs;
  if (anchorTimestampMs <= 0) return undefined;
  return state.firstAudioPlayedMs - anchorTimestampMs;
}

/**
 * Builds the `metrics` wire message by copying the session's own `turn_latency`
 * decomposition and layering transport-only marks (absolute timestamps, playout) on
 * top — see the field-grouping comment on `BrowserMetricsMessage`. Returns
 * `undefined` when the session never measured a voice TTFA for this turn (a
 * text-injected turn, or a fallback turn) — the caller records
 * `metrics.unmeasured_turn` instead of emitting a zero-filled row.
 */
export function buildBrowserMetricsMessage(
  turnId: string,
  state: TurnTimestampState,
): BrowserMetricsMessage | undefined {
  const turnLatency = state.turnLatency;
  if (!turnLatency) return undefined;

  const endpointingOwner = state.endpointingOwner;
  // A force-finalize watchdog firing overrides the emitter's reason: the STT plugin
  // that produced the completing eos cannot know the watchdog fired, but this mark
  // (stt.force_finalized) arrives independently on the bus, so the truth wins here
  // regardless of emitter.
  const endpointingReason = state.forceFinalized === true ? "force_finalized" : state.endpointingReason;
  const eouBudgetMs = buildEouBudgetMs(state);
  const ttfaPlayedMs = computeTtfaPlayedMs(turnLatency, state);

  return {
    type: "metrics",
    turnId,
    correlationId: turnId,
    ttfaMs: turnLatency.ttfaMs,
    anchor: turnLatency.anchor,
    unattributedMs: turnLatency.unattributedMs,
    ...(turnLatency.eouDelayMs !== undefined ? { eouDelayMs: turnLatency.eouDelayMs } : {}),
    ...(turnLatency.llmTtftMs !== undefined ? { llmTtftMs: turnLatency.llmTtftMs } : {}),
    ...(turnLatency.textAggregationMs !== undefined ? { textAggregationMs: turnLatency.textAggregationMs } : {}),
    ...(turnLatency.ttsTtfbMs !== undefined ? { ttsTtfbMs: turnLatency.ttsTtfbMs } : {}),
    ...(turnLatency.queuedMs !== undefined ? { queuedMs: turnLatency.queuedMs } : {}),
    ...(turnLatency.llmCallCount !== undefined ? { llmCallCount: turnLatency.llmCallCount } : {}),
    fillerUsed: turnLatency.fillerUsed,
    backchannelUsed: turnLatency.backchannelUsed,
    ...(state.speechEndMs > 0 ? { speechEndMs: state.speechEndMs } : {}),
    ...(state.textReadyMs > 0 ? { textReadyMs: state.textReadyMs } : {}),
    ...(state.firstAudioByteMs > 0 ? { firstAudioByteMs: state.firstAudioByteMs } : {}),
    ...(state.firstAudioPlayedMs > 0 ? { firstAudioPlayedMs: state.firstAudioPlayedMs } : {}),
    ...(state.lastAudioPlayedMs > 0 ? { lastAudioPlayedMs: state.lastAudioPlayedMs } : {}),
    ...(ttfaPlayedMs !== undefined ? { ttfaPlayedMs } : {}),
    ...(eouBudgetMs !== undefined ? { eouBudgetMs } : {}),
    ...(endpointingOwner !== undefined ? { endpointingOwner } : {}),
    ...(endpointingReason !== undefined ? { endpointingReason } : {}),
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
  private readonly bus: PipelineBus;
  private readonly turns: Map<string, TurnTimestampState>;

  constructor(
    private readonly session: VoiceAgentSession,
    private readonly onEmit: (message: BrowserMetricsMessage) => void,
    persistedTurns?: Map<string, TurnTimestampState>,
    private readonly options: TurnMetricsTrackerOptions = {},
  ) {
    this.bus = session.bus;
    this.turns = persistedTurns ?? new Map();
  }

  wire(disposers: Array<() => void>): void {
    const onTurnLatency: VoiceAgentSessionEvents["turn_latency"] = (event) => {
      this.turnState(event.turnId).turnLatency = event;
    };
    this.session.on("turn_latency", onTurnLatency);
    disposers.push(() => this.session.off("turn_latency", onTurnLatency));

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
        if (metric.name === "vad.stop_hangover_ms") {
          const hangoverMs = Number(metric.value);
          if (Number.isNaN(hangoverMs)) return;
          const state = this.turnState(metric.contextId);
          if (state.vadStopHangoverMs === 0) state.vadStopHangoverMs = hangoverMs;
          return;
        }
        if (metric.name === "stt.force_finalized") {
          this.turnState(metric.contextId).forceFinalized = true;
        }
      }),
      this.bus.on("eos.turn_complete", (pkt) => {
        const eos = pkt as EndOfSpeechPacket;
        const state = this.turnState(eos.contextId);
        if (state.eosMs === 0) state.eosMs = eos.timestampMs;
        // First eos wins (mirrors eosMs): the completing eos is the first, and any
        // duplicate is dropped downstream. Owner/reason are facts, not measurements.
        if (state.endpointingOwner === undefined && eos.endpointingOwner !== undefined) {
          state.endpointingOwner = eos.endpointingOwner;
        }
        if (state.endpointingReason === undefined && eos.endpointingReason !== undefined) {
          state.endpointingReason = eos.endpointingReason;
        }
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
          this.finalizeTurn(progress.contextId, state);
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
        // firstAudioPlayedMs, lastAudioPlayedMs, and downgrading ttfaPlayedMs to
        // absent on this runtime only. That is the exact runtime drift this tracker
        // exists to prevent.
        //
        // A non-zero firstAudioPlayedMs means playout has been reported, so wait.
        // The floor is only for clients that never report at all.
        if (state.firstAudioPlayedMs !== 0) return;
        this.finalizeTurn(end.contextId, state);
      }),
      this.bus.on("interrupt.tts", (pkt) => {
        this.turns.delete((pkt as InterruptTtsPacket).contextId);
      }),
    );
  }

  /**
   * Emits `metrics` from the stored turn_latency + marks, or — when the session
   * never measured a voice TTFA for this turn — records `metrics.unmeasured_turn`
   * instead of emitting a zero-filled row, so the gap is visible rather than silent.
   */
  private finalizeTurn(turnId: string, state: TurnTimestampState): void {
    const message = buildBrowserMetricsMessage(turnId, state);
    if (message) {
      this.onEmit(message);
    } else {
      this.bus.push(Route.Background, {
        kind: "metric.conversation",
        contextId: turnId,
        timestampMs: Date.now(),
        name: "metrics.unmeasured_turn",
        value: "1",
      });
    }
    this.turns.delete(turnId);
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
