// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Deepgram STT Plugin
//
// Follows Rapida's session-long connection pattern:
//   - One WebSocket per session (not per turn)
//   - Audio streams continuously, Deepgram endpointing finalizes turns
//   - No CloseStream — let Deepgram's built-in endpointing handle turn boundaries
//   - endpointing=5000ms (matching Rapida's default)
//   - Interim transcripts for real-time display
//   - Final transcripts can trigger eos.turn_complete, or Pipecat EOS can own finalization
//
// Guards (Syrinx additions beyond Rapida):
//   - Tracks last interim transcript for force-finalization
//   - forceFinalize() emits pending transcript as final on close/timeout
//   - Prevents silent drop when audio < endpointing duration
//
// Reference: Rapida transformer/deepgram/stt.go + internal/stt_callback.go

import type { PipelineBus } from "@asyncdot/voice";
import {
  Route,
  type VoicePlugin,
  type PluginConfig,
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
  private smartFormat: boolean = true;
  private interimResults: boolean = true;
  private confidenceThreshold: number = 0;
  private finalizeOnSpeechFinal: boolean = true;
  private emitEosOnFinal: boolean = true;
  private providerFinalizeFallbackMs: number = 1200;

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

  // Guard: track last interim for force-finalization on short audio
  private lastInterimTranscript = "";
  private lastInterimConfidence = 0;
  private finalTranscriptParts: string[] = [];
  private finalConfidence = 0;
  private finalizeRequestedContextIds = new Set<string>();
  private ignoreNextProviderFinalContextIds = new Set<string>();
  private providerFinalizeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    this.apiKey = requireStringConfig(config, "api_key");
    this.sampleRate = (config["sample_rate"] as number) ?? 16000;
    this.model = optionalStringConfig(config, "model") ?? "nova-2";
    this.language = optionalStringConfig(config, "language") ?? "en-US";
    this.endpointing = (config["endpointing"] as number) ?? 300;
    this.smartFormat = (config["smart_format"] as boolean) ?? true;
    this.interimResults = (config["interim_results"] as boolean) ?? true;
    this.confidenceThreshold =
      (config["confidence_threshold"] as number) ?? 0;
    this.finalizeOnSpeechFinal = (config["finalize_on_speech_final"] as boolean) ?? true;
    this.emitEosOnFinal = (config["emit_eos_on_final"] as boolean) ?? true;
    this.providerFinalizeFallbackMs = (config["provider_finalize_fallback_ms"] as number) ?? 1200;
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
        await this.sendAudio(audioPkt.audio);
        if (this.streamStartTime === 0) {
          this.streamStartTime = Date.now();
        }
      }),

      // Turn change handler
      bus.on("turn.change", (pkt: unknown) => {
        const tc = pkt as { contextId: string };
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

    const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
    this.ws = new WebSocket(url, {
      headers: { Authorization: `Token ${this.apiKey}` },
    });

    this.ws.on("open", () => {
      this.ready = true;
      this.connResolver?.();
      this.connResolver = null;
      this.connRejecter = null;
    });

    this.ws.on("message", (data: import("ws").RawData) => {
      try {
        const msg = JSON.parse(data.toString());
        const alt = msg.channel?.alternatives?.[0];
        if (!alt?.transcript) return;

        const transcript = alt.transcript.trim();
        const confidence = alt.confidence ?? 0;

        // Guard: track last interim for force-finalize
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

        if (msg.is_final) {
          if (this.ignoreNextProviderFinalContextIds.delete(this.currentContextId)) {
            this.resetPendingTranscript();
            return;
          }
          this.appendFinalSegment(transcript, confidence);
          const finalizeRequested = this.finalizeRequestedContextIds.has(this.currentContextId);
          if (this.finalizeOnSpeechFinal && (msg.speech_final === true || finalizeRequested)) {
            this.pushFinal(this.combinedFinalTranscript(), this.finalConfidence);
            this.resetPendingTranscript();
          }
        } else {
          this.pushInterim(transcript);
        }
      } catch {
        // Parse errors are non-critical
      }
    });

    this.ws.on("error", (err: Error) => {
      this.ready = false;
      this.connRejecter?.(err);
      this.connResolver = null;
      this.connRejecter = null;
      const category = categorizeSttError(err);
      this.bus?.push(Route.Critical, {
        kind: "stt.error",
        contextId: this.currentContextId,
        timestampMs: Date.now(),
        component: "stt" as const,
        category,
        cause: err,
        isRecoverable: isRecoverable(category),
      });
      if (isRecoverable(category)) {
        void this.reconnect();
      }
    });

    this.ws.on("close", () => {
      this.ready = false;
      this.connRejecter?.(new Error("Deepgram STT WebSocket closed before ready"));
      this.connResolver = null;
      this.connRejecter = null;
      if (!this.closed && !this.reconnecting) {
        void this.reconnect();
      }
    });
  }

  /** Stream audio to Deepgram immediately. No batching, no CloseStream. */
  async sendAudio(audio: Uint8Array): Promise<void> {
    if (!this.ready) {
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
    if (
      this.ws?.readyState === (this.ws as import("ws").WebSocket).OPEN
    ) {
      this.ws.send(audio);
    }
  }

  /**
   * Force-finalize the current turn with the last known interim transcript.
   *
   * Guard for: short audio clips (< 5s) where Deepgram's 5000ms endpointing
   * never fires. Also called on session close() for pending transcription.
   */
  forceFinalize(contextId?: string): void {
    const ctxId = contextId ?? this.currentContextId;
    if (!ctxId || !this.bus) return;
    this.requestProviderFinalize(ctxId);
  }

  private pushCachedFinal(contextId?: string): void {
    const ctxId = contextId ?? this.currentContextId;
    const transcript = this.combinedFinalTranscript() || this.lastInterimTranscript;
    const confidence = this.finalConfidence || this.lastInterimConfidence;

    if (!transcript || !this.bus) return;

    this.ignoreNextProviderFinalContextIds.add(ctxId);
    this.pushFinal(transcript, confidence, ctxId);

    this.resetPendingTranscript();
  }

  private requestProviderFinalize(contextId: string): void {
    this.finalizeRequestedContextIds.add(contextId);
    if (this.ws?.readyState === (this.ws as import("ws").WebSocket).OPEN) {
      this.ws.send(JSON.stringify({ type: "Finalize" }));
    }

    this.clearProviderFinalizeTimer(contextId);
    if (this.providerFinalizeFallbackMs <= 0) return;
    const timer = setTimeout(() => {
      this.providerFinalizeTimers.delete(contextId);
      this.pushCachedFinal(contextId);
    }, this.providerFinalizeFallbackMs);
    this.providerFinalizeTimers.set(contextId, timer);
  }

  /** Emit final transcript + EOS turn complete. */
  private pushFinal(transcript: string, confidence: number, contextId = this.currentContextId): void {
    const ctxId = contextId;
    this.finalizeRequestedContextIds.delete(ctxId);
    this.clearProviderFinalizeTimer(ctxId);
    this.bus?.push(Route.Main, {
      kind: "stt.result",
      contextId: ctxId,
      timestampMs: Date.now(),
      text: transcript,
      confidence,
      language: this.language,
    });

    if (this.emitEosOnFinal) {
      this.bus?.push(Route.Main, {
        kind: "eos.turn_complete",
        contextId: ctxId,
        timestampMs: Date.now(),
        text: transcript,
        transcripts: [],
      });
    }
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

  async close(): Promise<void> {
    this.closed = true;
    for (const dispose of this.disposers.splice(0)) dispose();
    // Guard: force-finalize pending transcription (short audio, no endpointing)
    if (this.lastInterimTranscript) {
      this.pushCachedFinal();
    }
    for (const timer of this.providerFinalizeTimers.values()) clearTimeout(timer);
    this.providerFinalizeTimers.clear();
    this.finalizeRequestedContextIds.clear();
    this.ignoreNextProviderFinalContextIds.clear();

    if (this.ws) {
      this.ws.close();
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
}
