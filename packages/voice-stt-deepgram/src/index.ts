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
//   - Final transcripts trigger eos.turn_complete
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

// =============================================================================
// Plugin
// =============================================================================

export class DeepgramSTTPlugin implements VoicePlugin {
  private bus: PipelineBus | null = null;
  private apiKey: string = "";
  private sampleRate: number = 16000;
  private model: string = "nova-2";
  private language: string = "en-US";
  private endpointing: number = 5000;
  private smartFormat: boolean = true;
  private interimResults: boolean = true;
  private confidenceThreshold: number = 0;

  // Session-long WebSocket
  private ws: import("ws").WebSocket | null = null;
  private ready = false;
  private connResolver: (() => void) | null = null;
  private currentContextId = "";
  private streamStartTime = 0;

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    this.apiKey = requireStringConfig(config, "api_key");
    this.sampleRate = (config["sample_rate"] as number) ?? 16000;
    this.model = optionalStringConfig(config, "model") ?? "nova-2";
    this.language = optionalStringConfig(config, "language") ?? "en-US";
    this.endpointing = (config["endpointing"] as number) ?? 5000;
    this.smartFormat = (config["smart_format"] as boolean) ?? true;
    this.interimResults = (config["interim_results"] as boolean) ?? true;
    this.confidenceThreshold = (config["confidence_threshold"] as number) ?? 0;

    // Open session-long WebSocket (Rapida pattern)
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
    });

    this.ws.on("message", (data: import("ws").RawData) => {
      try {
        const msg = JSON.parse(data.toString());
        const alt = msg.channel?.alternatives?.[0];
        if (!alt?.transcript) return;

        const transcript = alt.transcript.trim();
        const confidence = alt.confidence ?? 0;

        // Confidence threshold filter (Rapida pattern)
        if (this.confidenceThreshold > 0 && confidence < this.confidenceThreshold) {
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
          // Final transcript — turn complete (Rapida pattern: push STT result + EOS)
          const ctxId = this.currentContextId;
          this.bus?.push(Route.Main, {
            kind: "stt.result",
            contextId: ctxId,
            timestampMs: Date.now(),
            text: transcript,
            confidence,
            language: this.language,
          });

          // EndOfSpeech turn complete — triggers LLM processing
          this.bus?.push(Route.Main, {
            kind: "eos.turn_complete",
            contextId: ctxId,
            timestampMs: Date.now(),
            text: transcript,
            transcripts: [],
          });

          // Debug event
          this.bus?.push(Route.Background, {
            kind: "metric.conversation",
            contextId: ctxId,
            timestampMs: Date.now(),
            name: "stt_latency_ms",
            value: String(Date.now() - this.streamStartTime),
          });
        } else {
          // Interim transcript — real-time display only
          this.bus?.push(Route.Main, {
            kind: "stt.interim",
            contextId: this.currentContextId,
            timestampMs: Date.now(),
            text: transcript,
          });
        }
      } catch {
        // Parse errors are non-critical
      }
    });

    this.ws.on("error", (err: Error) => {
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
    });

    this.ws.on("close", () => {
      this.ready = false;
      this.bus?.push(Route.Background, {
        kind: "metric.conversation",
        contextId: this.currentContextId,
        timestampMs: Date.now(),
        name: "stt_connection_closed",
        value: "1",
      });
    });

    // Listen for audio packets on the bus — stream immediately (Rapida pattern)
    bus.on("stt.audio", async (pkt: unknown) => {
      const audioPkt = pkt as { audio: Uint8Array; contextId?: string };
      await this.sendAudio(audioPkt.audio);
      if (audioPkt.contextId) {
        this.currentContextId = audioPkt.contextId;
      }
      if (this.streamStartTime === 0) {
        this.streamStartTime = Date.now();
      }
    });

    // Handle turn changes — reset latency tracking (Rapida pattern)
    bus.on("turn.change", (pkt: unknown) => {
      const tc = pkt as { contextId: string };
      this.currentContextId = tc.contextId;
      this.streamStartTime = Date.now();
    });

    // Handle STT interrupts — reset tracking (Rapida pattern)
    bus.on("interrupt.stt", () => {
      this.streamStartTime = Date.now();
    });
  }

  /**
   * Stream audio to Deepgram immediately. No batching, no CloseStream.
   * Deepgram's built-in endpointing (5000ms) handles turn boundaries.
   * This is the Rapida pattern.
   */
  async sendAudio(audio: Uint8Array): Promise<void> {
    if (!this.ready) {
      await new Promise<void>((r) => {
        this.connResolver = r;
      });
    }
    if (this.ws?.readyState === (this.ws as import("ws").WebSocket).OPEN) {
      this.ws.send(audio);
    }
  }

  async close(): Promise<void> {
    if (this.ws) {
      // Rapida pattern: client.Stop() — gracefully close the session-long connection
      this.ws.close();
      this.ws = null;
    }
    this.bus = null;
    this.ready = false;
  }
}
