// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Deepgram STT Plugin
//
// Follows Rapida's session-long connection pattern:
//   - One WebSocket per session (not per turn)
//   - Audio streams continuously, VAD/EOS requests Deepgram Finalize
//   - KeepAlive holds the session open during post-turn silence and playout
//   - CloseStream is only used when the session is shutting down, never per turn
//   - Interim transcripts for real-time display
//   - Final transcripts can trigger eos.turn_complete, or Pipecat EOS can own finalization
//
// Guards (Syrinx additions beyond Rapida):
//   - forceFinalize() sends Deepgram Finalize and waits for provider confirmation
//   - Never promotes interim/cached text to final without speech_final/from_finalize
//   - Emits provider-boundary metrics for audio byte/duration and finalize provenance
//
// Reference: Rapida transformer/deepgram/stt.go + internal/stt_callback.go

import type { PipelineBus } from "@asyncdot/voice";
import {
  Route,
  type AudioFormat,
  type VoicePlugin,
  type PluginConfig,
  type SttErrorPacket,
  assertAudioFormat,
  assertAudioPayload,
  requireStringConfig,
  optionalStringConfig,
  readRetryConfig,
  categorizeSttError,
  isRecoverable,
} from "@asyncdot/voice";
import { WebSocketConnection, type SocketData, type SocketFactory } from "@asyncdot/voice-ws";
import { createNodeWsSocket } from "@asyncdot/voice-ws/node";

interface ProviderTranscriptState {
  lastInterimTranscript: string;
  lastInterimConfidence: number;
  finalTranscriptParts: string[];
  finalConfidence: number;
}

export class DeepgramSTTPlugin implements VoicePlugin {
  private bus: PipelineBus | null = null;
  private apiKey: string = "";
  private sampleRate: number = 16000;
  private model: string = "nova-3";
  private language: string = "en-US";
  private endpointing: number = 300;
  private endpointUrl: string = "wss://api.deepgram.com/v1/listen";
  private smartFormat: boolean = true;
  private interimResults: boolean = true;
  private confidenceThreshold: number = 0;
  private finalizeOnSpeechFinal: boolean = true;
  private emitEosOnFinal: boolean = true;
  private providerFinalizeTimeoutMs: number = 1200;
  // Consecutive unconfirmed Finalize timeouts that force a connection reset. A single
  // slow finalize discards its turn but keeps the (healthy) socket; only repeated
  // failures with no confirmed final between them look like a wedged stream worth
  // reconnecting. Prevents one slow finalize from cascading into the next turns.
  private finalizeResetThreshold: number = 2;
  private consecutiveFinalizeTimeouts = 0;
  // When the provider never confirms a Finalize, complete the turn with the best transcript
  // already buffered instead of dropping it. For live conversation a reply on slightly
  // imperfect text beats silently losing the user's turn. Opt-in (off preserves the strict
  // "never promote unconfirmed" behavior for callers that need it).
  private finalizeTimeoutFallback: boolean = false;
  private keepAliveIntervalMs: number = 3000;

  // Session-long WebSocket, managed by the shared connection (reconnect, keepalive).
  private conn: WebSocketConnection | null = null;
  private currentContextId = "";
  private streamStartTime = 0;
  private disposers: Array<() => void> = [];

  constructor(private readonly socketFactory: SocketFactory = createNodeWsSocket) {}

  private transcriptStateByContextId = new Map<string, ProviderTranscriptState>();
  private finalizeRequestedContextIds = new Set<string>();
  private finalizedContextIds = new Set<string>();
  private speechFinalContextIds = new Set<string>();
  private ignoreNextProviderFinalContextIds = new Set<string>();
  private providerFinalizeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private providerFinalizeCorrelationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingProviderFinalizeContextIds: string[] = [];
  private audioStatsByContextId = new Map<string, {
    bytes: number;
    chunks: number;
    firstSentAtMs: number;
    lastSentAtMs: number;
  }>();
  private audioFormat: AudioFormat = { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 };

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    this.apiKey = requireStringConfig(config, "api_key");
    this.sampleRate = (config["sample_rate"] as number) ?? 16000;
    this.model = optionalStringConfig(config, "model") ?? "nova-3";
    this.language = optionalStringConfig(config, "language") ?? "en-US";
    this.endpointing = (config["endpointing"] as number) ?? 300;
    this.endpointUrl = optionalStringConfig(config, "endpoint_url") ?? "wss://api.deepgram.com/v1/listen";
    this.smartFormat = (config["smart_format"] as boolean) ?? true;
    this.interimResults = (config["interim_results"] as boolean) ?? true;
    this.confidenceThreshold =
      (config["confidence_threshold"] as number) ?? 0;
    this.finalizeOnSpeechFinal = (config["finalize_on_speech_final"] as boolean) ?? true;
    this.emitEosOnFinal = (config["emit_eos_on_final"] as boolean) ?? true;
    this.providerFinalizeTimeoutMs = (config["provider_finalize_timeout_ms"] as number) ?? 1200;
    this.finalizeResetThreshold = (config["finalize_reset_threshold"] as number) ?? 2;
    this.finalizeTimeoutFallback = (config["finalize_timeout_fallback"] as boolean) ?? false;
    this.keepAliveIntervalMs = (config["keep_alive_interval_ms"] as number) ?? 3000;
    this.audioFormat = { encoding: "pcm_s16le", sampleRateHz: this.sampleRate, channels: 1 };
    assertAudioFormat(this.audioFormat);

    // One session-long socket, managed (reconnect + KeepAlive) by WebSocketConnection.
    this.conn = new WebSocketConnection({
      url: () => {
        const params = new URLSearchParams({
          encoding: "linear16",
          sample_rate: String(this.sampleRate),
          interim_results: String(this.interimResults),
          endpointing: String(this.endpointing),
          smart_format: String(this.smartFormat),
          model: this.model,
          language: this.language,
          channels: "1",
          no_delay: "true",
        });
        const separator = this.endpointUrl.includes("?") ? "&" : "?";
        return `${this.endpointUrl}${separator}${params.toString()}`;
      },
      headers: { Authorization: `Token ${this.apiKey}` },
      socketFactory: this.socketFactory,
      retry: readRetryConfig(config),
      keepAliveIntervalMs: this.keepAliveIntervalMs,
      keepAliveMessage: () => JSON.stringify({ type: "KeepAlive" }),
      onMessage: (data) => {
        if (typeof data === "string") this.handleProviderMessage(data);
      },
      onConnectionLost: (err) => {
        this.discardProviderStateForReconnect();
        this.emitError(this.currentContextId, err);
      },
    });
    await this.conn.connect();

    // Listen for audio packets — stream immediately
    this.disposers.push(
      bus.on("stt.audio", async (pkt: unknown) => {
        const audioPkt = pkt as { audio: Uint8Array; contextId?: string };
        if (audioPkt.contextId) {
          this.currentContextId = audioPkt.contextId;
        }
        const sent = await this.sendAudio(audioPkt.audio, this.currentContextId);
        if (sent) {
          this.recordAudioSent(this.currentContextId, audioPkt.audio.byteLength);
        }
        if (this.streamStartTime === 0) {
          this.streamStartTime = Date.now();
        }
      }),

      // Turn change handler
      bus.on("turn.change", (pkt: unknown) => {
        const tc = pkt as { contextId: string };
        this.currentContextId = tc.contextId;
        this.streamStartTime = Date.now();
      }),

      // STT interrupt handler
      bus.on("interrupt.stt", () => {
        this.streamStartTime = Date.now();
        this.resetTurnTranscriptState();
      }),
      bus.on("stt.finalize", (pkt: unknown) => {
        const request = pkt as { contextId: string };
        this.forceFinalize(request.contextId);
      }),
    );
  }

  private handleProviderMessage(data: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data) as Record<string, unknown>;
    } catch (err) {
      this.emitError(
        this.currentContextId,
        new Error(`Deepgram STT provider sent malformed JSON: ${err instanceof Error ? err.message : String(err)}`),
      );
      return;
    }

    if (isDeepgramProviderError(msg)) {
      this.emitError(this.currentContextId, deepgramProviderError(msg));
      return;
    }

    const alt = providerAlternative(msg);
    if (!alt || typeof alt["transcript"] !== "string") return;

    const transcript = alt["transcript"].trim();
    const confidence = typeof alt["confidence"] === "number" ? alt["confidence"] : 0;
    const fromFinalize = msg["from_finalize"] === true;
    const speechFinal = msg["speech_final"] === true;
    const providerContextId = msg["is_final"] === true
      ? this.contextIdForProviderFinal({ speechFinal, fromFinalize })
      : this.currentContextId;
    if (!transcript || this.finalizedContextIds.has(providerContextId)) return;

    const state = this.transcriptState(providerContextId);
    state.lastInterimTranscript = transcript;
    state.lastInterimConfidence = confidence;

    // Confidence threshold filter (Rapida pattern)
    if (
      this.confidenceThreshold > 0 &&
      confidence < this.confidenceThreshold
    ) {
      this.bus?.push(Route.Background, {
        kind: "metric.conversation",
        contextId: providerContextId,
        timestampMs: Date.now(),
        name: "stt_low_confidence",
        value: String(confidence),
      });
      return;
    }

    if (msg["is_final"] === true) {
      if (this.ignoreNextProviderFinalContextIds.delete(providerContextId)) {
        this.resetPendingTranscript(providerContextId);
        return;
      }
      this.appendFinalSegment(providerContextId, transcript, confidence);
      if (speechFinal) this.speechFinalContextIds.add(providerContextId);
      const finalizeRequested = this.finalizeRequestedContextIds.has(providerContextId);
      this.pushProviderFinalMetric(providerContextId, transcript, {
        confidence,
        speechFinal,
        fromFinalize,
        finalizeRequested,
      });
      this.pushResult(transcript, confidence, providerContextId, {
        name: "deepgram",
        speechFinal,
        fromFinalize,
        finalizeRequested,
      });
      if (speechFinal || fromFinalize) {
        this.resolveProviderFinalize(providerContextId);
      }
      if (this.emitEosOnFinal && ((this.finalizeOnSpeechFinal && speechFinal) || (finalizeRequested && fromFinalize))) {
        this.pushTurnComplete(providerContextId);
      }
    } else {
      this.pushInterim(transcript, providerContextId);
    }
  }

  /** Stream audio to Deepgram immediately. No batching, no CloseStream. */
  async sendAudio(audio: Uint8Array, contextId = this.currentContextId): Promise<boolean> {
    if (audio.byteLength === 0) return true;
    try {
      assertAudioPayload(this.audioFormat, audio);
      if (!this.conn) throw new Error("Deepgram STT is not connected");
      await this.conn.ensureReady();
      this.conn.send(audio);
      return true;
    } catch (err) {
      this.emitError(contextId, err instanceof Error ? err : new Error(String(err)));
      return false;
    }
  }

  /** Request that Deepgram flush buffered audio and return provider-final text. */
  forceFinalize(contextId?: string): void {
    const ctxId = contextId ?? this.currentContextId;
    if (!ctxId || !this.bus) return;
    this.requestProviderFinalize(ctxId);
  }

  private requestProviderFinalize(contextId: string): void {
    if (this.finalizedContextIds.has(contextId)) return;
    this.finalizeRequestedContextIds.add(contextId);
    this.trackPendingProviderFinalize(contextId);
    this.pushMetric(contextId, "stt_provider_finalize_requested", this.audioStats(contextId));
    if (this.conn?.isReady) {
      this.conn.send(JSON.stringify({ type: "Finalize" }));
    }
    if (!this.emitEosOnFinal && this.hasFinalTranscript(contextId)) {
      this.scheduleProviderFinalizeCorrelationExpiry(contextId);
      return;
    }

    this.clearProviderFinalizeTimer(contextId);
    if (this.providerFinalizeTimeoutMs <= 0) return;
    const timer = setTimeout(() => {
      this.providerFinalizeTimers.delete(contextId);
      this.handleProviderFinalizeTimeout(contextId);
    }, this.providerFinalizeTimeoutMs);
    this.providerFinalizeTimers.set(contextId, timer);
  }

  private handleProviderFinalizeTimeout(contextId: string): void {
    if (!this.finalizeRequestedContextIds.has(contextId) || this.finalizedContextIds.has(contextId)) return;
    this.pushMetric(contextId, "stt_provider_finalize_timeout", this.audioStats(contextId));

    // Graceful degradation (opt-in): rather than dropping the user's turn when the provider
    // never confirms the Finalize, complete it with the best buffered text — confirmed
    // is_final segments first, then the latest interim — so the turn still reaches the LLM.
    if (this.finalizeTimeoutFallback) {
      const state = this.transcriptState(contextId);
      const fallbackText = this.combinedFinalTranscript(contextId) || state.lastInterimTranscript;
      if (fallbackText) {
        this.pushMetric(contextId, "stt_provider_finalize_timeout_fallback", this.audioStats(contextId));
        // A late provider-final for this turn must not double-emit after we promote here.
        this.ignoreNextProviderFinalContextIds.add(contextId);
        this.pushFinal(fallbackText, state.finalConfidence || state.lastInterimConfidence, contextId);
        this.resetPendingTranscript(contextId);
        return;
      }
    }

    this.discardUnconfirmedTurn(contextId);
    this.emitError(
      contextId,
      new Error("Deepgram STT Finalize timed out before speech_final/from_finalize confirmation"),
    );
    // A single slow finalize is not a wedged stream: keep the healthy socket so the
    // next turn streams normally instead of stalling on a reconnect (which loses
    // Deepgram-side context and cascades into more timeouts). Only reconnect once the
    // failures repeat without a confirmed final between them (counter cleared in pushFinal).
    this.consecutiveFinalizeTimeouts += 1;
    if (this.consecutiveFinalizeTimeouts >= this.finalizeResetThreshold) {
      this.consecutiveFinalizeTimeouts = 0;
      this.conn?.reset();
    }
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

  /** Emit final transcript + EOS turn complete. */
  private pushFinal(transcript: string, confidence: number, contextId = this.currentContextId): void {
    const ctxId = contextId;
    this.resolveProviderFinalize(ctxId);
    this.finalizedContextIds.add(ctxId);
    this.consecutiveFinalizeTimeouts = 0;
    this.pushMetric(ctxId, "stt_audio_sent", this.audioStats(ctxId));
    this.pushResult(transcript, confidence, ctxId);

    if (this.emitEosOnFinal) {
      this.bus?.push(Route.Main, {
        kind: "eos.turn_complete",
        contextId: ctxId,
        timestampMs: Date.now(),
        text: transcript,
        transcripts: [],
      });
    }
    this.audioStatsByContextId.delete(ctxId);
  }

  private pushTurnComplete(contextId: string): void {
    const transcript = this.combinedFinalTranscript(contextId);
    if (!transcript || !this.bus) return;
    this.resolveProviderFinalize(contextId);
    this.finalizedContextIds.add(contextId);
    this.consecutiveFinalizeTimeouts = 0;
    this.pushMetric(contextId, "stt_audio_sent", this.audioStats(contextId));
    this.bus.push(Route.Main, {
      kind: "eos.turn_complete",
      contextId,
      timestampMs: Date.now(),
      text: transcript,
      transcripts: [],
    });
    this.audioStatsByContextId.delete(contextId);
    this.resetPendingTranscript(contextId);
  }

  private pushResult(
    transcript: string,
    confidence: number,
    contextId = this.currentContextId,
    provider?: Record<string, unknown>,
  ): void {
    this.bus?.push(Route.Main, {
      kind: "stt.result",
      contextId,
      timestampMs: Date.now(),
      text: transcript,
      confidence,
      language: this.language,
      provider,
    });
  }

  /** Emit interim transcript for real-time display. */
  private pushInterim(transcript: string, contextId = this.currentContextId): void {
    this.bus?.push(Route.Main, {
      kind: "stt.interim",
      contextId,
      timestampMs: Date.now(),
      text: transcript,
    });
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
    return this.transcriptState(contextId).finalTranscriptParts.join(" ").replace(/\s+/g, " ").trim();
  }

  private resetPendingTranscript(contextId: string): void {
    this.transcriptStateByContextId.delete(contextId);
  }

  private resetTurnTranscriptState(): void {
    this.resetPendingTranscript(this.currentContextId);
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

  private contextIdForProviderFinal(flags: { readonly speechFinal: boolean; readonly fromFinalize: boolean }): string {
    const pending = this.pendingProviderFinalizeContextIds[0];
    if (pending && (flags.speechFinal || flags.fromFinalize)) return pending;
    return this.currentContextId;
  }

  private trackPendingProviderFinalize(contextId: string): void {
    if (!this.pendingProviderFinalizeContextIds.includes(contextId)) {
      this.pendingProviderFinalizeContextIds.push(contextId);
    }
  }

  private removePendingProviderFinalize(contextId: string): void {
    this.pendingProviderFinalizeContextIds = this.pendingProviderFinalizeContextIds.filter((ctxId) => ctxId !== contextId);
  }

  private scheduleProviderFinalizeCorrelationExpiry(contextId: string): void {
    this.clearProviderFinalizeCorrelationTimer(contextId);
    if (this.providerFinalizeTimeoutMs <= 0) return;
    const timer = setTimeout(() => {
      this.providerFinalizeCorrelationTimers.delete(contextId);
      this.finalizeRequestedContextIds.delete(contextId);
      this.removePendingProviderFinalize(contextId);
    }, this.providerFinalizeTimeoutMs);
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
      durationMs: Math.round((stats.bytes / 2 / this.sampleRate) * 1000),
      wallClockMs: stats.lastSentAtMs - stats.firstSentAtMs,
    };
  }

  private pushMetric(contextId: string, name: string, value: unknown): void {
    this.bus?.push(Route.Background, {
      kind: "metric.conversation",
      contextId,
      timestampMs: Date.now(),
      name,
      value: typeof value === "string" ? value : JSON.stringify(value),
    });
  }

  private emitError(contextId: string, err: Error): void {
    const category = categorizeSttError(err);
    const packet: SttErrorPacket = {
      kind: "stt.error",
      contextId,
      timestampMs: Date.now(),
      component: "stt" as const,
      category,
      cause: err,
      isRecoverable: isRecoverable(category),
    };
    this.bus?.push(Route.Critical, packet);
  }

  async close(): Promise<void> {
    for (const dispose of this.disposers.splice(0)) dispose();
    if (this.transcriptStateByContextId.size > 0) {
      this.pushMetric(this.currentContextId, "stt_pending_transcript_discarded_on_close", this.audioStats(this.currentContextId));
    }
    for (const timer of this.providerFinalizeTimers.values()) clearTimeout(timer);
    this.providerFinalizeTimers.clear();
    for (const timer of this.providerFinalizeCorrelationTimers.values()) clearTimeout(timer);
    this.providerFinalizeCorrelationTimers.clear();
    this.pendingProviderFinalizeContextIds = [];
    this.finalizeRequestedContextIds.clear();
    this.finalizedContextIds.clear();
    this.speechFinalContextIds.clear();
    this.ignoreNextProviderFinalContextIds.clear();
    this.transcriptStateByContextId.clear();
    this.audioStatsByContextId.clear();

    if (this.conn) {
      // Graceful end-of-stream so Deepgram flushes and closes cleanly.
      if (this.conn.isReady) {
        try {
          this.conn.send(JSON.stringify({ type: "CloseStream" }));
        } catch {
          // best effort
        }
      }
      await this.conn.close();
      this.conn = null;
    }
    this.bus = null;
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

  private discardProviderStateForReconnect(): void {
    const contextId = this.currentContextId;
    const discarded = this.transcriptStateByContextId.size > 0 ||
      this.finalizeRequestedContextIds.size > 0 ||
      this.audioStatsByContextId.size > 0 ||
      this.providerFinalizeTimers.size > 0 ||
      this.providerFinalizeCorrelationTimers.size > 0;
    for (const timer of this.providerFinalizeTimers.values()) clearTimeout(timer);
    this.providerFinalizeTimers.clear();
    for (const timer of this.providerFinalizeCorrelationTimers.values()) clearTimeout(timer);
    this.providerFinalizeCorrelationTimers.clear();
    this.pendingProviderFinalizeContextIds = [];
    this.finalizeRequestedContextIds.clear();
    this.speechFinalContextIds.clear();
    this.ignoreNextProviderFinalContextIds.clear();
    this.audioStatsByContextId.clear();
    // A reconnect (from any cause) starts a fresh provider stream, so the wedged-stream
    // signal resets too — otherwise a stale count could force an avoidable reset on the
    // first timeout after reconnecting.
    this.consecutiveFinalizeTimeouts = 0;
    this.transcriptStateByContextId.clear();
    if (discarded && contextId) {
      this.pushMetric(contextId, "stt_provider_reconnect_discarded_state", {});
    }
  }

}

function providerAlternative(msg: Record<string, unknown>): Record<string, unknown> | null {
  const channel = msg["channel"];
  if (!channel || typeof channel !== "object") return null;
  const alternatives = (channel as { alternatives?: unknown }).alternatives;
  if (!Array.isArray(alternatives)) return null;
  const first = alternatives[0];
  return first && typeof first === "object" ? first as Record<string, unknown> : null;
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
  ].filter((part) => part.length > 0).join(" ");
  return new Error(details ? `Deepgram STT provider error: ${details}` : "Deepgram STT provider error");
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}
