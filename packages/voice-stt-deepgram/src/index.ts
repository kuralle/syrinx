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
  type VoicePlugin,
  type PluginConfig,
  type SttErrorPacket,
  requireStringConfig,
  optionalStringConfig,
  categorizeSttError,
  isRecoverable,
} from "@asyncdot/voice";

export class DeepgramSTTPlugin implements VoicePlugin {
  private bus: PipelineBus | null = null;
  private apiKey: string = "";
  private sampleRate: number = 16000;
  private model: string = "nova-2";
  private language: string = "en-US";
  private endpointing: number = 300;
  private endpointUrl: string = "wss://api.deepgram.com/v1/listen";
  private smartFormat: boolean = true;
  private interimResults: boolean = true;
  private confidenceThreshold: number = 0;
  private finalizeOnSpeechFinal: boolean = true;
  private emitEosOnFinal: boolean = true;
  private providerFinalizeTimeoutMs: number = 1200;
  private keepAliveIntervalMs: number = 3000;

  // Session-long WebSocket
  private ws: import("ws").WebSocket | null = null;
  private ready = false;
  private connResolver: (() => void) | null = null;
  private connRejecter: ((err: Error) => void) | null = null;
  private currentContextId = "";
  private streamStartTime = 0;
  private closed = false;
  private reconnecting = false;
  private disposers: Array<() => void> = [];
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;

  // Track provider text for display/debug only; final output requires provider confirmation.
  private lastInterimTranscript = "";
  private lastInterimConfidence = 0;
  private finalTranscriptParts: string[] = [];
  private finalConfidence = 0;
  private finalizeRequestedContextIds = new Set<string>();
  private finalizedContextIds = new Set<string>();
  private speechFinalContextIds = new Set<string>();
  private ignoreNextProviderFinalContextIds = new Set<string>();
  private providerFinalizeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private audioStatsByContextId = new Map<string, {
    bytes: number;
    chunks: number;
    firstSentAtMs: number;
    lastSentAtMs: number;
  }>();

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    this.apiKey = requireStringConfig(config, "api_key");
    this.sampleRate = (config["sample_rate"] as number) ?? 16000;
    this.model = optionalStringConfig(config, "model") ?? "nova-2";
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
    this.keepAliveIntervalMs = (config["keep_alive_interval_ms"] as number) ?? 3000;
    this.closed = false;

    // Open session-long WebSocket (Rapida pattern)
    await this.connect();

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
        if (this.currentContextId && this.currentContextId !== tc.contextId) {
          this.clearProviderFinalizeTimer(this.currentContextId);
          this.finalizeRequestedContextIds.delete(this.currentContextId);
          this.finalizedContextIds.delete(this.currentContextId);
          this.speechFinalContextIds.delete(this.currentContextId);
          this.audioStatsByContextId.delete(this.currentContextId);
        }
        this.currentContextId = tc.contextId;
        this.streamStartTime = Date.now();
        this.resetTurnTranscriptState();
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

  private async connect(): Promise<void> {
    const { default: WebSocket } = await import("ws");
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
    const url = `${this.endpointUrl}${separator}${params.toString()}`;
    this.ws = new WebSocket(url, {
      headers: { Authorization: `Token ${this.apiKey}` },
    });

    this.ws.on("open", () => {
      this.ready = true;
      this.startKeepAlive();
      this.connResolver?.();
      this.connResolver = null;
      this.connRejecter = null;
    });

    this.ws.on("message", (data: import("ws").RawData) => {
      this.handleProviderMessage(data);
    });

    this.ws.on("error", (err: Error) => {
      this.ready = false;
      this.connRejecter?.(err);
      this.connResolver = null;
      this.connRejecter = null;
      this.emitError(this.currentContextId, err);
      const category = categorizeSttError(err);
      if (isRecoverable(category)) {
        void this.reconnect();
      }
    });

    this.ws.on("close", (code, reason) => {
      this.ready = false;
      this.stopKeepAlive();
      this.connRejecter?.(new Error("Deepgram STT WebSocket closed before ready"));
      this.connResolver = null;
      this.connRejecter = null;
      if (!this.closed && !this.reconnecting) {
        this.emitError(this.currentContextId, deepgramCloseError(code, reason));
        void this.reconnect();
      }
    });
  }

  private handleProviderMessage(data: import("ws").RawData): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString()) as Record<string, unknown>;
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
    if (!transcript || this.finalizedContextIds.has(this.currentContextId)) return;

    // Track provider text for display/debug; do not treat it as EOS.
    this.lastInterimTranscript = transcript;
    this.lastInterimConfidence = confidence;

    // Confidence threshold filter (Rapida pattern)
    if (
      this.confidenceThreshold > 0 &&
      confidence < this.confidenceThreshold
    ) {
      this.bus?.push(Route.Background, {
        kind: "metric.conversation",
        contextId: this.currentContextId,
        timestampMs: Date.now(),
        name: "stt_low_confidence",
        value: String(confidence),
      });
      return;
    }

    if (msg["is_final"] === true) {
      if (this.ignoreNextProviderFinalContextIds.delete(this.currentContextId)) {
        this.resetPendingTranscript();
        return;
      }
      this.appendFinalSegment(transcript, confidence);
      const fromFinalize = msg["from_finalize"] === true;
      const speechFinal = msg["speech_final"] === true;
      if (speechFinal) this.speechFinalContextIds.add(this.currentContextId);
      const finalizeRequested = this.finalizeRequestedContextIds.has(this.currentContextId);
      this.pushProviderFinalMetric(transcript, {
        confidence,
        speechFinal,
        fromFinalize,
        finalizeRequested,
      });
      if (!this.emitEosOnFinal && finalizeRequested && (speechFinal || fromFinalize)) {
        this.pushBufferedProviderFinal(this.currentContextId);
      } else if (this.emitEosOnFinal && ((this.finalizeOnSpeechFinal && speechFinal) || (finalizeRequested && fromFinalize))) {
        this.pushFinal(this.combinedFinalTranscript(), this.finalConfidence);
        this.resetPendingTranscript();
      }
    } else {
      this.pushInterim(transcript);
    }
  }

  /** Stream audio to Deepgram immediately. No batching, no CloseStream. */
  async sendAudio(audio: Uint8Array, contextId = this.currentContextId): Promise<boolean> {
    try {
      await this.waitUntilReady();
      const ws = this.ws;
      if (!ws || ws.readyState !== ws.OPEN) {
        throw new Error("Deepgram STT WebSocket is not open");
      }
      if (audio.byteLength === 0) return true;
      ws.send(audio);
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
    this.pushMetric(contextId, "stt_provider_finalize_requested", this.audioStats(contextId));
    if (this.ws?.readyState === (this.ws as import("ws").WebSocket).OPEN) {
      this.ws.send(JSON.stringify({ type: "Finalize" }));
    }
    if (!this.emitEosOnFinal && this.speechFinalContextIds.has(contextId) && this.pushBufferedProviderFinal(contextId)) {
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
    this.discardUnconfirmedTurn(contextId);
    this.emitError(
      contextId,
      new Error("Deepgram STT Finalize timed out before speech_final/from_finalize confirmation"),
    );
    void this.reconnect();
  }

  private discardUnconfirmedTurn(contextId: string): void {
    this.clearProviderFinalizeTimer(contextId);
    this.finalizeRequestedContextIds.delete(contextId);
    this.speechFinalContextIds.delete(contextId);
    this.ignoreNextProviderFinalContextIds.add(contextId);
    this.audioStatsByContextId.delete(contextId);
    this.resetPendingTranscript();
  }

  private pushBufferedProviderFinal(contextId: string): boolean {
    const transcript = this.combinedFinalTranscript();
    if (!transcript || !this.bus) return false;

    this.ignoreNextProviderFinalContextIds.add(contextId);
    this.pushMetric(contextId, "stt_provider_final_buffer_released", this.audioStats(contextId));
    this.pushFinal(transcript, this.finalConfidence, contextId);
    this.resetPendingTranscript();
    return true;
  }

  /** Emit final transcript + EOS turn complete. */
  private pushFinal(transcript: string, confidence: number, contextId = this.currentContextId): void {
    const ctxId = contextId;
    this.finalizeRequestedContextIds.delete(ctxId);
    this.clearProviderFinalizeTimer(ctxId);
    this.finalizedContextIds.add(ctxId);
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

  private pushResult(transcript: string, confidence: number, contextId = this.currentContextId): void {
    this.bus?.push(Route.Main, {
      kind: "stt.result",
      contextId,
      timestampMs: Date.now(),
      text: transcript,
      confidence,
      language: this.language,
    });
  }

  /** Emit interim transcript for real-time display. */
  private pushInterim(transcript: string): void {
    this.bus?.push(Route.Main, {
      kind: "stt.interim",
      contextId: this.currentContextId,
      timestampMs: Date.now(),
      text: transcript,
    });
  }

  private appendFinalSegment(transcript: string, confidence: number): void {
    if (transcript.length === 0) return;
    const last = this.finalTranscriptParts.at(-1);
    if (last !== transcript) {
      this.finalTranscriptParts.push(transcript);
    }
    this.finalConfidence = Math.max(this.finalConfidence, confidence);
  }

  private combinedFinalTranscript(): string {
    return this.finalTranscriptParts.join(" ").replace(/\s+/g, " ").trim();
  }

  private resetPendingTranscript(): void {
    this.finalTranscriptParts = [];
    this.finalConfidence = 0;
    this.lastInterimTranscript = "";
    this.lastInterimConfidence = 0;
  }

  private resetTurnTranscriptState(): void {
    this.resetPendingTranscript();
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
    transcript: string,
    flags: {
      readonly confidence: number;
      readonly speechFinal: boolean;
      readonly fromFinalize: boolean;
      readonly finalizeRequested: boolean;
    },
  ): void {
    const contextId = this.currentContextId;
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

  private async waitUntilReady(): Promise<void> {
    if (this.ready) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Deepgram STT WebSocket connect timeout"));
      }, 10_000);
      this.connResolver = () => {
        clearTimeout(timeout);
        resolve();
      };
      this.connRejecter = (err) => {
        clearTimeout(timeout);
        reject(err);
      };
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopKeepAlive();
    for (const dispose of this.disposers.splice(0)) dispose();
    if (this.lastInterimTranscript || this.finalTranscriptParts.length > 0) {
      this.pushMetric(this.currentContextId, "stt_pending_transcript_discarded_on_close", this.audioStats(this.currentContextId));
    }
    for (const timer of this.providerFinalizeTimers.values()) clearTimeout(timer);
    this.providerFinalizeTimers.clear();
    this.finalizeRequestedContextIds.clear();
    this.finalizedContextIds.clear();
    this.speechFinalContextIds.clear();
    this.ignoreNextProviderFinalContextIds.clear();
    this.audioStatsByContextId.clear();

    if (this.ws) {
      await this.closeProviderStream();
      this.ws = null;
    }
    this.bus = null;
    this.ready = false;
  }

  private clearProviderFinalizeTimer(contextId: string): void {
    const timer = this.providerFinalizeTimers.get(contextId);
    if (!timer) return;
    clearTimeout(timer);
    this.providerFinalizeTimers.delete(contextId);
  }

  private async reconnect(): Promise<void> {
    if (this.closed || this.reconnecting) return;
    this.reconnecting = true;
    this.discardProviderStateForReconnect();
    this.stopKeepAlive();
    try {
      this.ws?.close();
    } catch {
      // best effort
    }
    try {
      await this.connect();
    } finally {
      this.reconnecting = false;
    }
  }

  private discardProviderStateForReconnect(): void {
    const contextId = this.currentContextId;
    const discarded = this.finalTranscriptParts.length > 0 ||
      this.lastInterimTranscript.length > 0 ||
      this.finalizeRequestedContextIds.size > 0 ||
      this.audioStatsByContextId.size > 0 ||
      this.providerFinalizeTimers.size > 0;
    for (const timer of this.providerFinalizeTimers.values()) clearTimeout(timer);
    this.providerFinalizeTimers.clear();
    this.finalizeRequestedContextIds.clear();
    this.speechFinalContextIds.clear();
    this.ignoreNextProviderFinalContextIds.clear();
    this.audioStatsByContextId.clear();
    this.resetPendingTranscript();
    if (discarded && contextId) {
      this.pushMetric(contextId, "stt_provider_reconnect_discarded_state", {});
    }
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    if (this.keepAliveIntervalMs <= 0) return;
    this.keepAliveTimer = setInterval(() => {
      if (this.closed) return;
      const ws = this.ws;
      if (!ws || ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify({ type: "KeepAlive" }));
    }, this.keepAliveIntervalMs);
  }

  private stopKeepAlive(): void {
    if (!this.keepAliveTimer) return;
    clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }

  private async closeProviderStream(): Promise<void> {
    this.stopKeepAlive();
    const ws = this.ws;
    if (!ws || ws.readyState !== ws.OPEN) {
      ws?.close();
      return;
    }
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 250);
      ws.send(JSON.stringify({ type: "CloseStream" }), () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    ws.close();
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

function deepgramCloseError(code: number, reason: Buffer): Error {
  const reasonText = reason.toString("utf8").trim();
  return new Error(
    reasonText
      ? `Deepgram STT WebSocket closed unexpectedly: code=${code} reason=${reasonText}`
      : `Deepgram STT WebSocket closed unexpectedly: code=${code}`,
  );
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}
