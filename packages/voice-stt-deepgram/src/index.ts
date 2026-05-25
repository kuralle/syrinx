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

  // Session-long WebSocket
  private ws: import("ws").WebSocket | null = null;
  private ready = false;
  private connResolver: (() => void) | null = null;
  private currentContextId = "";
  private streamStartTime = 0;

  // Guard: track last interim for force-finalization on short audio
  private lastInterimTranscript = "";
  private lastInterimConfidence = 0;
  private hasFinalForCurrentTurn = false;

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
          this.hasFinalForCurrentTurn = true;
          this.pushFinal(transcript, confidence);
        } else {
          this.pushInterim(transcript);
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
    });

    // Listen for audio packets — stream immediately
    bus.on("stt.audio", async (pkt: unknown) => {
      const audioPkt = pkt as { audio: Uint8Array; contextId?: string };
      await this.sendAudio(audioPkt.audio);
      if (audioPkt.contextId) {
        this.currentContextId = audioPkt.contextId;
      }
      if (this.streamStartTime === 0) {
        this.streamStartTime = Date.now();
      }
      // Guard: new audio = new turn, reset final flag
      this.hasFinalForCurrentTurn = false;
    });

    // Turn change handler
    bus.on("turn.change", (pkt: unknown) => {
      const tc = pkt as { contextId: string };
      this.currentContextId = tc.contextId;
      this.streamStartTime = Date.now();
      this.hasFinalForCurrentTurn = false;
    });

    // STT interrupt handler
    bus.on("interrupt.stt", () => {
      this.streamStartTime = Date.now();
      this.hasFinalForCurrentTurn = false;
    });
  }

  /** Stream audio to Deepgram immediately. No batching, no CloseStream. */
  async sendAudio(audio: Uint8Array): Promise<void> {
    if (!this.ready) {
      await new Promise<void>((r) => {
        this.connResolver = r;
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
    const transcript = this.lastInterimTranscript;
    const confidence = this.lastInterimConfidence;

    // Don't force-finalize if we already got a final for this turn
    if (this.hasFinalForCurrentTurn) return;
    if (!transcript || !this.bus) return;

    this.hasFinalForCurrentTurn = true;
    this.pushFinal(transcript, confidence);

    // Clear tracking
    this.lastInterimTranscript = "";
    this.lastInterimConfidence = 0;
  }

  /** Emit final transcript + EOS turn complete. */
  private pushFinal(transcript: string, confidence: number): void {
    const ctxId = this.currentContextId;
    this.bus?.push(Route.Main, {
      kind: "stt.result",
      contextId: ctxId,
      timestampMs: Date.now(),
      text: transcript,
      confidence,
      language: this.language,
    });

    this.bus?.push(Route.Main, {
      kind: "eos.turn_complete",
      contextId: ctxId,
      timestampMs: Date.now(),
      text: transcript,
      transcripts: [],
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

  async close(): Promise<void> {
    // Guard: force-finalize pending transcription (short audio, no endpointing)
    if (this.lastInterimTranscript && !this.hasFinalForCurrentTurn) {
      this.forceFinalize();
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.bus = null;
    this.ready = false;
  }
}
