// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Deepgram Nova STT Plugin
//
// Session lifecycle (socket, reconnect, keepalive, billing funnel) lives in
// @kuralle-syrinx/stt-core. This file is the Nova wire protocol: listen URL +
// query knobs, Finalize + CloseStream frames, and the provider-policy state
// machine (multi-segment accumulation, speech_final/from_finalize gating,
// Finalize timeout/fallback/reset, UtteranceEnd backstop).

import {
  Route,
  assertAudioFormat,
  optionalStringConfig,
  readProviderRetryConfig,
  requireStringConfig,
  type AudioFormat,
  type PipelineBus,
  type PluginConfig,
  type SttReconfigure,
  type SttReconfigurePartial,
  type VoicePlugin,
} from "@kuralle-syrinx/core";
import {
  defaultNodeSocketFactory,
  startStreamingSttSession,
  type SttEvent,
  type SttProtocolHost,
  type SttWireProtocol,
  type StreamingSttSession,
} from "@kuralle-syrinx/stt-core";
import type { SocketData, SocketFactory } from "@kuralle-syrinx/ws";

interface ProviderTranscriptState {
  lastInterimTranscript: string;
  lastInterimConfidence: number;
  finalTranscriptParts: string[];
  finalConfidence: number;
}

/**
 * A retired-contextId set (finalized turns) must stay bounded: contextIds are
 * per-turn on every transport (telephony rotates `<callSid>-t<n>`), so an
 * unbounded set would grow one entry per turn for the life of a call. Keeping a
 * recent-turns window is enough to reject the late/duplicate provider finals the
 * set exists to guard against, without leaking memory over a long conversation.
 */
const MAX_RETIRED_CONTEXTS = 256;

function boundedAdd(set: Set<string>, value: string, cap: number): void {
  set.add(value);
  while (set.size > cap) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}

type MetricSink = (contextId: string, name: string, value: unknown) => void;

interface DeepgramNovaProtocolConfig {
  readonly model: string;
  readonly language: string;
  readonly sampleRate: number;
  readonly vadEvents: boolean;
  readonly confidenceThreshold: number;
  readonly finalizeOnSpeechFinal: boolean;
  readonly emitEosOnFinal: boolean;
  readonly providerFinalizeTimeoutMs: number;
  readonly finalizeResetThreshold: number;
  readonly finalizeTimeoutFallback: boolean;
  readonly getContextId: () => string;
  readonly onMetric: MetricSink;
}

class DeepgramSttWireProtocol implements SttWireProtocol {
  private host: SttProtocolHost | null = null;
  private transcriptStateByContextId = new Map<string, ProviderTranscriptState>();
  private finalizeRequestedContextIds = new Set<string>();
  private finalizedContextIds = new Set<string>();
  private speechFinalContextIds = new Set<string>();
  private ignoreNextProviderFinalContextIds = new Set<string>();
  private providerFinalizeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private providerFinalizeCorrelationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingProviderFinalizeContextIds: string[] = [];
  private audioStatsByContextId = new Map<
    string,
    {
      bytes: number;
      chunks: number;
      firstSentAtMs: number;
      lastSentAtMs: number;
      billedBytes?: number;
    }
  >();
  private consecutiveFinalizeTimeouts = 0;

  constructor(private readonly cfg: DeepgramNovaProtocolConfig) {}

  attach(host: SttProtocolHost): void {
    this.host = host;
  }

  encodeAudio(audio: Uint8Array): readonly SocketData[] {
    // Record after the engine has committed to sending (encodeAudio is only invoked
    // on the send path). Bytes are used for provider-boundary metrics, not billing
    // (billing is the base's sent-bytes funnel).
    this.recordAudioSent(this.cfg.getContextId(), audio.byteLength);
    return [audio];
  }

  encodeFinalize(contextId: string): readonly SocketData[] {
    if (!contextId || this.finalizedContextIds.has(contextId)) return [];
    return [JSON.stringify({ type: "Finalize" })];
  }

  onFinalizeSent(contextId: string): void {
    if (!contextId || this.finalizedContextIds.has(contextId)) return;
    this.finalizeRequestedContextIds.add(contextId);
    this.trackPendingProviderFinalize(contextId);
    this.pushMetric(contextId, "stt_provider_finalize_requested", this.audioStats(contextId));

    if (!this.cfg.emitEosOnFinal && this.hasFinalTranscript(contextId)) {
      this.scheduleProviderFinalizeCorrelationExpiry(contextId);
      return;
    }

    this.clearProviderFinalizeTimer(contextId);
    if (this.cfg.providerFinalizeTimeoutMs <= 0) return;
    const timer = setTimeout(() => {
      this.providerFinalizeTimers.delete(contextId);
      this.handleProviderFinalizeTimeout(contextId);
    }, this.cfg.providerFinalizeTimeoutMs);
    this.providerFinalizeTimers.set(contextId, timer);
  }

  encodeClose(): readonly SocketData[] {
    if (this.transcriptStateByContextId.size > 0) {
      this.pushMetric(
        this.cfg.getContextId(),
        "stt_pending_transcript_discarded_on_close",
        this.audioStats(this.cfg.getContextId()),
      );
    }
    this.clearAllProviderState({ keepFinalized: false });
    return [JSON.stringify({ type: "CloseStream" })];
  }

  onConnectionLost(): void {
    this.discardProviderStateForReconnect();
  }

  decode(data: SocketData, _isBinary: boolean): readonly SttEvent[] {
    if (typeof data !== "string") return [];
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data) as Record<string, unknown>;
    } catch (err) {
      return [
        {
          type: "error",
          contextId: this.cfg.getContextId(),
          error: new Error(
            `Deepgram STT provider sent malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
          ),
        },
      ];
    }

    if (isDeepgramProviderError(msg)) {
      return [
        {
          type: "error",
          contextId: this.cfg.getContextId(),
          error: deepgramProviderError(msg),
        },
      ];
    }

    if (msg["type"] === "SpeechStarted") {
      if (!this.cfg.vadEvents) return [];
      return [{ type: "speech_started", contextId: this.cfg.getContextId() }];
    }

    if (msg["type"] === "UtteranceEnd") {
      return this.handleUtteranceEnd();
    }

    const alt = providerAlternative(msg);
    if (!alt || typeof alt["transcript"] !== "string") return [];

    const transcript = alt["transcript"].trim();
    const confidence = typeof alt["confidence"] === "number" ? alt["confidence"] : 0;
    const fromFinalize = msg["from_finalize"] === true;
    const speechFinal = msg["speech_final"] === true;
    const providerContextId =
      msg["is_final"] === true
        ? this.contextIdForProviderFinal({ speechFinal, fromFinalize })
        : this.cfg.getContextId();
    if (!transcript || this.finalizedContextIds.has(providerContextId)) return [];

    const state = this.transcriptState(providerContextId);
    state.lastInterimTranscript = transcript;
    state.lastInterimConfidence = confidence;

    if (this.cfg.confidenceThreshold > 0 && confidence < this.cfg.confidenceThreshold) {
      this.pushMetric(providerContextId, "stt_low_confidence", String(confidence));
      return [];
    }

    if (msg["is_final"] === true) {
      return this.handleIsFinal(providerContextId, transcript, confidence, {
        speechFinal,
        fromFinalize,
      });
    }

    return this.interimEvents(transcript, providerContextId, alt);
  }

  /** Clear per-turn transcript buffers (interrupt.stt). */
  resetTurnTranscriptState(): void {
    this.resetPendingTranscript(this.cfg.getContextId());
  }

  private handleUtteranceEnd(): readonly SttEvent[] {
    const ctxId = this.cfg.getContextId();
    if (
      !this.cfg.emitEosOnFinal ||
      !ctxId ||
      this.finalizedContextIds.has(ctxId) ||
      !this.combinedFinalTranscript(ctxId)
    ) {
      return [];
    }
    this.pushMetric(ctxId, "deepgram.utterance_end_backstop", "1");
    return this.commitTurnComplete(ctxId);
  }

  private handleIsFinal(
    providerContextId: string,
    transcript: string,
    confidence: number,
    flags: { readonly speechFinal: boolean; readonly fromFinalize: boolean },
  ): readonly SttEvent[] {
    if (this.ignoreNextProviderFinalContextIds.delete(providerContextId)) {
      this.resetPendingTranscript(providerContextId);
      return [];
    }
    this.appendFinalSegment(providerContextId, transcript, confidence);
    if (flags.speechFinal) this.speechFinalContextIds.add(providerContextId);
    const finalizeRequested = this.finalizeRequestedContextIds.has(providerContextId);
    this.pushProviderFinalMetric(providerContextId, transcript, {
      confidence,
      speechFinal: flags.speechFinal,
      fromFinalize: flags.fromFinalize,
      finalizeRequested,
    });

    const events: SttEvent[] = [
      {
        type: "final",
        contextId: providerContextId,
        text: transcript,
        confidence,
        language: this.cfg.language,
        // No speechFinal: base emits stt.result + bills, but NOT eos (eos comes via turn_complete).
        provider: {
          name: "deepgram",
          model: this.cfg.model,
          region: "global",
          speechFinal: flags.speechFinal,
          fromFinalize: flags.fromFinalize,
          finalizeRequested,
        },
      },
    ];

    if (flags.speechFinal || flags.fromFinalize) {
      this.resolveProviderFinalize(providerContextId);
    }
    if (
      this.cfg.emitEosOnFinal &&
      ((this.cfg.finalizeOnSpeechFinal && flags.speechFinal) ||
        (finalizeRequested && flags.fromFinalize))
    ) {
      events.push(...this.commitTurnComplete(providerContextId));
    }
    return events;
  }

  private interimEvents(
    transcript: string,
    contextId: string,
    alt: Record<string, unknown>,
  ): readonly SttEvent[] {
    const wordTimings = mapProviderWordTimings(alt);
    const events: SttEvent[] = [{ type: "interim", contextId, text: transcript }];
    events.push({
      type: "partial",
      contextId,
      text: transcript,
      ...(wordTimings ? { wordTimings } : {}),
    });
    return events;
  }

  private commitTurnComplete(contextId: string): readonly SttEvent[] {
    const transcript = this.combinedFinalTranscript(contextId);
    if (!transcript) return [];
    this.resolveProviderFinalize(contextId);
    boundedAdd(this.finalizedContextIds, contextId, MAX_RETIRED_CONTEXTS);
    this.consecutiveFinalizeTimeouts = 0;
    this.pushMetric(contextId, "stt_audio_sent", this.audioStats(contextId));
    this.audioStatsByContextId.delete(contextId);
    this.resetPendingTranscript(contextId);
    return [{ type: "turn_complete", contextId, text: transcript }];
  }

  private handleProviderFinalizeTimeout(contextId: string): void {
    if (!this.finalizeRequestedContextIds.has(contextId) || this.finalizedContextIds.has(contextId)) {
      return;
    }
    this.pushMetric(contextId, "stt_provider_finalize_timeout", this.audioStats(contextId));

    if (this.cfg.finalizeTimeoutFallback) {
      const state = this.transcriptState(contextId);
      const fallbackText = this.combinedFinalTranscript(contextId) || state.lastInterimTranscript;
      if (fallbackText) {
        this.pushMetric(
          contextId,
          "stt_provider_finalize_timeout_fallback",
          this.audioStats(contextId),
        );
        this.ignoreNextProviderFinalContextIds.add(contextId);
        this.promoteFallbackFinal(
          fallbackText,
          state.finalConfidence || state.lastInterimConfidence,
          contextId,
        );
        this.resetPendingTranscript(contextId);
        return;
      }
      this.pushMetric(
        contextId,
        "stt_provider_finalize_timeout_empty_discard",
        this.audioStats(contextId),
      );
      this.discardUnconfirmedTurn(contextId);
      return;
    }

    this.discardUnconfirmedTurn(contextId);
    this.host?.emit({
      type: "error",
      contextId,
      error: new Error(
        "Deepgram STT Finalize timed out before speech_final/from_finalize confirmation",
      ),
    });
    this.consecutiveFinalizeTimeouts += 1;
    if (this.consecutiveFinalizeTimeouts >= this.cfg.finalizeResetThreshold) {
      this.consecutiveFinalizeTimeouts = 0;
      this.host?.reset();
    }
  }

  /** Fallback promote: result + optional eos via base (speechFinal: true). */
  private promoteFallbackFinal(transcript: string, confidence: number, contextId: string): void {
    this.resolveProviderFinalize(contextId);
    boundedAdd(this.finalizedContextIds, contextId, MAX_RETIRED_CONTEXTS);
    this.consecutiveFinalizeTimeouts = 0;
    this.pushMetric(contextId, "stt_audio_sent", this.audioStats(contextId));
    this.host?.emit({
      type: "final",
      contextId,
      text: transcript,
      confidence,
      language: this.cfg.language,
      speechFinal: true,
      provider: { name: "deepgram", model: this.cfg.model, region: "global" },
    });
    this.audioStatsByContextId.delete(contextId);
  }

  private discardUnconfirmedTurn(contextId: string): void {
    this.clearProviderFinalizeTimer(contextId);
    this.finalizeRequestedContextIds.delete(contextId);
    this.removePendingProviderFinalize(contextId);
    this.speechFinalContextIds.delete(contextId);
    this.ignoreNextProviderFinalContextIds.add(contextId);
    this.audioStatsByContextId.delete(contextId);
    this.resetPendingTranscript(contextId);
  }

  private discardProviderStateForReconnect(): void {
    const contextId = this.cfg.getContextId();
    const discarded =
      this.transcriptStateByContextId.size > 0 ||
      this.finalizeRequestedContextIds.size > 0 ||
      this.audioStatsByContextId.size > 0 ||
      this.providerFinalizeTimers.size > 0 ||
      this.providerFinalizeCorrelationTimers.size > 0;
    this.clearAllProviderState({ keepFinalized: true });
    // A reconnect (from any cause) starts a fresh provider stream, so the wedged-stream
    // signal resets too — otherwise a stale count could force an avoidable reset on the
    // first timeout after reconnecting.
    this.consecutiveFinalizeTimeouts = 0;
    if (discarded && contextId) {
      this.pushMetric(contextId, "stt_provider_reconnect_discarded_state", {});
    }
  }

  private clearAllProviderState(opts: { keepFinalized: boolean }): void {
    for (const timer of this.providerFinalizeTimers.values()) clearTimeout(timer);
    this.providerFinalizeTimers.clear();
    for (const timer of this.providerFinalizeCorrelationTimers.values()) clearTimeout(timer);
    this.providerFinalizeCorrelationTimers.clear();
    this.pendingProviderFinalizeContextIds = [];
    this.finalizeRequestedContextIds.clear();
    if (!opts.keepFinalized) this.finalizedContextIds.clear();
    this.speechFinalContextIds.clear();
    this.ignoreNextProviderFinalContextIds.clear();
    this.transcriptStateByContextId.clear();
    this.audioStatsByContextId.clear();
  }

  private appendFinalSegment(contextId: string, transcript: string, confidence: number): void {
    if (transcript.length === 0) return;
    const state = this.transcriptState(contextId);
    const last = state.finalTranscriptParts.at(-1);
    if (last !== transcript) {
      state.finalTranscriptParts.push(transcript);
    }
    state.finalConfidence = Math.max(state.finalConfidence, confidence);
  }

  private combinedFinalTranscript(contextId: string): string {
    return this.transcriptState(contextId)
      .finalTranscriptParts.join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private resetPendingTranscript(contextId: string): void {
    this.transcriptStateByContextId.delete(contextId);
  }

  private transcriptState(contextId: string): ProviderTranscriptState {
    const existing = this.transcriptStateByContextId.get(contextId);
    if (existing) return existing;
    const next: ProviderTranscriptState = {
      lastInterimTranscript: "",
      lastInterimConfidence: 0,
      finalTranscriptParts: [],
      finalConfidence: 0,
    };
    this.transcriptStateByContextId.set(contextId, next);
    return next;
  }

  private hasFinalTranscript(contextId: string): boolean {
    const state = this.transcriptStateByContextId.get(contextId);
    return Boolean(state && state.finalTranscriptParts.length > 0);
  }

  private contextIdForProviderFinal(flags: {
    readonly speechFinal: boolean;
    readonly fromFinalize: boolean;
  }): string {
    const pending = this.pendingProviderFinalizeContextIds[0];
    if (pending && (flags.speechFinal || flags.fromFinalize)) return pending;
    return this.cfg.getContextId();
  }

  private trackPendingProviderFinalize(contextId: string): void {
    if (!this.pendingProviderFinalizeContextIds.includes(contextId)) {
      this.pendingProviderFinalizeContextIds.push(contextId);
    }
  }

  private removePendingProviderFinalize(contextId: string): void {
    this.pendingProviderFinalizeContextIds = this.pendingProviderFinalizeContextIds.filter(
      (ctxId) => ctxId !== contextId,
    );
  }

  private scheduleProviderFinalizeCorrelationExpiry(contextId: string): void {
    this.clearProviderFinalizeCorrelationTimer(contextId);
    if (this.cfg.providerFinalizeTimeoutMs <= 0) return;
    const timer = setTimeout(() => {
      this.providerFinalizeCorrelationTimers.delete(contextId);
      this.finalizeRequestedContextIds.delete(contextId);
      this.removePendingProviderFinalize(contextId);
    }, this.cfg.providerFinalizeTimeoutMs);
    this.providerFinalizeCorrelationTimers.set(contextId, timer);
  }

  private resolveProviderFinalize(contextId: string): void {
    this.finalizeRequestedContextIds.delete(contextId);
    this.clearProviderFinalizeTimer(contextId);
    this.clearProviderFinalizeCorrelationTimer(contextId);
    this.removePendingProviderFinalize(contextId);
  }

  private recordAudioSent(contextId: string, byteLength: number): void {
    if (!contextId) return;
    const now = Date.now();
    const current = this.audioStatsByContextId.get(contextId) ?? {
      bytes: 0,
      chunks: 0,
      firstSentAtMs: now,
      lastSentAtMs: now,
    };
    current.bytes += byteLength;
    current.chunks += 1;
    current.lastSentAtMs = now;
    this.audioStatsByContextId.set(contextId, current);
  }

  private pushProviderFinalMetric(
    contextId: string,
    transcript: string,
    flags: {
      readonly confidence: number;
      readonly speechFinal: boolean;
      readonly fromFinalize: boolean;
      readonly finalizeRequested: boolean;
    },
  ): void {
    this.pushMetric(contextId, "stt_provider_final_segment", {
      ...this.audioStats(contextId),
      transcriptChars: transcript.length,
      confidence: flags.confidence,
      speechFinal: flags.speechFinal,
      fromFinalize: flags.fromFinalize,
      finalizeRequested: flags.finalizeRequested,
    });
  }

  private audioStats(contextId: string): Record<string, number> {
    const stats = this.audioStatsByContextId.get(contextId);
    if (!stats) {
      return {
        bytes: 0,
        chunks: 0,
        durationMs: 0,
        wallClockMs: 0,
      };
    }
    return {
      bytes: stats.bytes,
      chunks: stats.chunks,
      durationMs: Math.round((stats.bytes / 2 / this.cfg.sampleRate) * 1000),
      wallClockMs: stats.lastSentAtMs - stats.firstSentAtMs,
    };
  }

  private pushMetric(contextId: string, name: string, value: unknown): void {
    this.cfg.onMetric(contextId, name, value);
  }

  private clearProviderFinalizeTimer(contextId: string): void {
    const timer = this.providerFinalizeTimers.get(contextId);
    if (!timer) return;
    clearTimeout(timer);
    this.providerFinalizeTimers.delete(contextId);
  }

  private clearProviderFinalizeCorrelationTimer(contextId: string): void {
    const timer = this.providerFinalizeCorrelationTimers.get(contextId);
    if (!timer) return;
    clearTimeout(timer);
    this.providerFinalizeCorrelationTimers.delete(contextId);
  }
}

export class DeepgramSTTPlugin implements VoicePlugin {
  readonly endpointingCapability = {
    owner: "provider_stt" as const,
    disableConfig: {
      emit_eos_on_final: false,
      finalize_on_speech_final: false,
    },
  };

  private bus: PipelineBus | null = null;
  private session: StreamingSttSession | null = null;
  private protocol: DeepgramSttWireProtocol | null = null;
  private currentContextId = "";
  private model = "nova-3";
  private language = "en-US";
  private sampleRate = 16000;
  private endpointing = 300;
  private endpointUrl = "wss://api.deepgram.com/v1/listen";
  private smartFormat = true;
  private interimResults = true;
  private vadEvents = false;
  private utteranceEndMs = 0;
  private keyterms: readonly string[] = [];
  private encoding = "linear16";
  private channels = 1;
  private noDelay = true;
  private queryParams: Record<string, unknown> | undefined;
  private disposers: Array<() => void> = [];

  constructor(private readonly socketFactory?: SocketFactory) {}

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    const apiKey = requireStringConfig(config, "api_key");
    this.sampleRate = (config["sample_rate"] as number) ?? 16000;
    this.model = optionalStringConfig(config, "model") ?? "nova-3";
    this.language = optionalStringConfig(config, "language") ?? "en-US";
    this.endpointing = (config["endpointing"] as number) ?? 300;
    this.endpointUrl =
      optionalStringConfig(config, "endpoint_url") ?? "wss://api.deepgram.com/v1/listen";
    this.smartFormat = (config["smart_format"] as boolean) ?? true;
    this.interimResults = (config["interim_results"] as boolean) ?? true;
    // Opt-in: provider SpeechStarted → vad.speech_started is for VAD-less
    // deployments (edge cascade). On sessions with a local VAD the duplicate,
    // laggier speech-start signal corrupts VAD/EOS-owned turn-taking (the turn
    // never completes) — proven by the Fly telephony spike.
    this.vadEvents = (config["vad_events"] as boolean) ?? false;
    {
      const raw = (config["utterance_end_ms"] as number) ?? 0;
      this.utteranceEndMs = raw > 0 ? Math.max(1000, raw) : 0;
    }
    const confidenceThreshold = (config["confidence_threshold"] as number) ?? 0;
    const finalizeOnSpeechFinal = (config["finalize_on_speech_final"] as boolean) ?? true;
    const emitEosOnFinal = (config["emit_eos_on_final"] as boolean) ?? true;
    const providerFinalizeTimeoutMs = (config["provider_finalize_timeout_ms"] as number) ?? 1200;
    const finalizeResetThreshold = (config["finalize_reset_threshold"] as number) ?? 2;
    const finalizeTimeoutFallback = (config["finalize_timeout_fallback"] as boolean) ?? false;
    const keepAliveIntervalMs = (config["keep_alive_interval_ms"] as number) ?? 3000;
    {
      const raw = config["keyterm"];
      this.keyterms = Array.isArray(raw)
        ? raw.filter((t): t is string => typeof t === "string" && t.length > 0)
        : typeof raw === "string" && raw.length > 0
          ? [raw]
          : [];
    }
    this.encoding = optionalStringConfig(config, "encoding") ?? "linear16";
    this.channels =
      typeof config["channels"] === "number" && Number.isFinite(config["channels"])
        ? Math.max(1, Math.floor(config["channels"] as number))
        : 1;
    this.noDelay = (config["no_delay"] as boolean) ?? true;
    this.queryParams = readPlainObject(config["query_params"]);

    const audioFormat: AudioFormat = {
      encoding: "pcm_s16le",
      sampleRateHz: this.sampleRate,
      channels: 1,
    };
    assertAudioFormat(audioFormat);

    // Track context before the session handlers so encodeAudio sees the live turn id.
    this.disposers.push(
      bus.on("stt.audio", (pkt: unknown) => {
        const audioPkt = pkt as { contextId?: string };
        if (audioPkt.contextId) this.currentContextId = audioPkt.contextId;
      }),
      bus.on("turn.change", (pkt: unknown) => {
        this.currentContextId = (pkt as { contextId: string }).contextId;
      }),
      bus.on("interrupt.stt", () => {
        this.protocol?.resetTurnTranscriptState();
      }),
    );

    this.protocol = new DeepgramSttWireProtocol({
      model: this.model,
      language: this.language,
      sampleRate: this.sampleRate,
      vadEvents: this.vadEvents,
      confidenceThreshold,
      finalizeOnSpeechFinal,
      emitEosOnFinal,
      providerFinalizeTimeoutMs,
      finalizeResetThreshold,
      finalizeTimeoutFallback,
      getContextId: () => this.currentContextId,
      onMetric: (contextId, name, value) => {
        bus.push(Route.Background, {
          kind: "metric.conversation",
          contextId,
          timestampMs: Date.now(),
          name,
          value: typeof value === "string" ? value : JSON.stringify(value),
        });
      },
    });

    this.session = await startStreamingSttSession(bus, {
      protocol: this.protocol,
      provider: { name: "deepgram", model: this.model, region: "global" },
      format: audioFormat,
      language: this.language,
      emitEosOnFinal,
      url: () => {
        const params = new URLSearchParams({
          encoding: this.encoding,
          sample_rate: String(this.sampleRate),
          interim_results: String(this.interimResults),
          endpointing: String(this.endpointing),
          smart_format: String(this.smartFormat),
          model: this.model,
          language: this.language,
          channels: String(this.channels),
          no_delay: String(this.noDelay),
          vad_events: String(this.vadEvents),
          ...(this.utteranceEndMs > 0 ? { utterance_end_ms: String(this.utteranceEndMs) } : {}),
        });
        for (const term of this.keyterms) params.append("keyterm", term);
        applyQueryParams(params, this.queryParams);
        const separator = this.endpointUrl.includes("?") ? "&" : "?";
        return `${this.endpointUrl}${separator}${params.toString()}`;
      },
      headers: { Authorization: `Token ${apiKey}` },
      socketFactory: this.socketFactory ?? (await defaultNodeSocketFactory()),
      retry: readProviderRetryConfig(config),
      replayBufferSize: (config["replay_buffer_size"] as number) ?? 64,
      keepAliveIntervalMs,
      keepAliveMessage: () => JSON.stringify({ type: "KeepAlive" }),
      metricPrefix: "stt.deepgram",
    });
  }

  /**
   * Per-turn reconfigure of keyterms / silence endpointing. Nova has no in-band
   * Configure message — updates instance state then reconnects via `session.reset()`
   * so the re-evaluated `url()` carries the new params (LiveKit Nova-3 pattern).
   * Call only at a turn boundary (between utterances); reconnect is not free and
   * would drop mid-utterance audio. keyterms REPLACE the list (Flux semantics).
   * Flux-only fields (eotThreshold, eagerEotThreshold, eotTimeoutMs, contextText)
   * are ignored.
   */
  get sttReconfigure(): SttReconfigure {
    return this;
  }

  reconfigure(partial: SttReconfigurePartial): void {
    let changed = false;
    if (partial.keyterms !== undefined) {
      this.keyterms = partial.keyterms;
      changed = true;
    }
    if (partial.endpointingMs !== undefined) {
      this.endpointing = partial.endpointingMs;
      changed = true;
    }
    if (changed) this.session?.reset();
  }

  /** Request that Deepgram flush buffered audio and return provider-final text. */
  forceFinalize(contextId?: string): void {
    const ctxId = contextId ?? this.currentContextId;
    if (!ctxId || !this.bus) return;
    this.bus.push(Route.Main, {
      kind: "stt.finalize",
      contextId: ctxId,
      timestampMs: Date.now(),
    });
  }

  async close(): Promise<void> {
    for (const dispose of this.disposers.splice(0)) dispose();
    await this.session?.dispose();
    this.session = null;
    this.protocol = null;
    this.bus = null;
  }
}

function mapProviderWordTimings(
  alt: Record<string, unknown> | null,
): ReadonlyArray<{ word: string; startMs: number; endMs: number; confidence: number }> | undefined {
  if (!alt) return undefined;
  const words = alt["words"];
  if (!Array.isArray(words)) return undefined;
  const timings: Array<{ word: string; startMs: number; endMs: number; confidence: number }> = [];
  for (const entry of words) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const word = row["word"];
    const start = row["start"];
    const end = row["end"];
    const confidence = row["confidence"];
    if (typeof word !== "string" || typeof start !== "number" || typeof end !== "number") continue;
    timings.push({
      word,
      startMs: start * 1000,
      endMs: end * 1000,
      confidence: typeof confidence === "number" ? confidence : 0,
    });
  }
  return timings.length > 0 ? timings : undefined;
}

function providerAlternative(msg: Record<string, unknown>): Record<string, unknown> | null {
  const channel = msg["channel"];
  if (!channel || typeof channel !== "object") return null;
  const alternatives = (channel as { alternatives?: unknown }).alternatives;
  if (!Array.isArray(alternatives)) return null;
  const first = alternatives[0];
  return first && typeof first === "object" ? (first as Record<string, unknown>) : null;
}

function isDeepgramProviderError(msg: Record<string, unknown>): boolean {
  const type = typeof msg["type"] === "string" ? msg["type"].toLowerCase() : "";
  return type === "error" || typeof msg["err_code"] === "string" || typeof msg["err_msg"] === "string";
}

function deepgramProviderError(msg: Record<string, unknown>): Error {
  const code = firstString(msg["code"], msg["err_code"]);
  const description = firstString(msg["description"], msg["message"], msg["err_msg"], msg["details"]);
  const requestId = firstString(msg["request_id"]);
  const details = [
    code ? `code=${code}` : "",
    description,
    requestId ? `request_id=${requestId}` : "",
  ]
    .filter((part) => part.length > 0)
    .join(" ");
  return new Error(details ? `Deepgram STT provider error: ${details}` : "Deepgram STT provider error");
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function readPlainObject(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

/** Merge open-ended provider query knobs. Arrays append; scalars set (override). */
function applyQueryParams(params: URLSearchParams, extra: Record<string, unknown> | undefined): void {
  if (!extra) return;
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) continue;
        params.append(key, String(item));
      }
      continue;
    }
    params.set(key, String(value));
  }
}
