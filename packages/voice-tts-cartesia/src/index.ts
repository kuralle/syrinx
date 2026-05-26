// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Cartesia TTS Plugin

import { randomUUID } from "node:crypto";

import type { PipelineBus } from "@asyncdot/voice";
import {
  Route,
  type PluginConfig,
  type RetryConfig,
  type TextToSpeechAudioPacket,
  type TextToSpeechEndPacket,
  type TtsErrorPacket,
  type VoicePlugin,
  categorizeTtsError,
  isRecoverable,
  optionalStringConfig,
  readRetryConfig,
  requireStringConfig,
  waitForRetryDelay,
} from "@asyncdot/voice";

export class CartesiaTTSPlugin implements VoicePlugin {
  private bus: PipelineBus | null = null;
  private ws: import("ws").WebSocket | null = null;
  private ready = false;
  private connResolver: (() => void) | null = null;
  private connRejecter: ((err: Error) => void) | null = null;
  private apiKey = "";
  private voiceId = "c2ac25f9-ecc4-4f56-9095-651354df60c0";
  private modelId = "sonic-2-2025-03-07";
  private sampleRate = 16000;
  private language = "en";
  private retryConfig: RetryConfig = readRetryConfig({});
  private closed = false;
  private disposers: Array<() => void> = [];

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    this.apiKey = requireStringConfig(config, "api_key");
    this.voiceId = optionalStringConfig(config, "voice_id") ?? this.voiceId;
    this.modelId = optionalStringConfig(config, "model_id") ?? this.modelId;
    this.sampleRate = (config["sample_rate"] as number) ?? this.sampleRate;
    this.language = optionalStringConfig(config, "language") ?? this.language;
    this.retryConfig = readRetryConfig(config);
    this.closed = false;

    await this.connect();

    this.disposers.push(
      bus.on("tts.text", async (pkt: unknown) => {
        const textPkt = pkt as { text: string; contextId: string };
        await this.sendText(textPkt.text, textPkt.contextId);
      }),
      bus.on("tts.done", async (pkt: unknown) => {
        const donePkt = pkt as { contextId: string };
        await this.flush(donePkt.contextId);
      }),
      bus.on("interrupt.tts", () => {
        this.flush().catch(() => {
          // Best-effort interruption.
        });
      }),
    );
  }

  async sendText(text: string, contextId: string): Promise<void> {
    if (!text.trim()) return;
    await this.sendWithRetry(
      JSON.stringify({
        model_id: this.modelId,
        transcript: text,
        voice: { mode: "id", id: this.voiceId },
        output_format: {
          container: "raw",
          encoding: "pcm_s16le",
          sample_rate: this.sampleRate,
        },
        language: this.language,
        context_id: contextId || randomUUID(),
        continue: true,
        add_timestamps: false,
      }),
      contextId,
    );
  }

  /** Flush/cancel current TTS generation (called on interrupt). */
  async flush(contextId = ""): Promise<void> {
    await this.sendWithRetry(
      JSON.stringify({
        model_id: this.modelId,
        transcript: "",
        voice: { mode: "id", id: this.voiceId },
        output_format: {
          container: "raw",
          encoding: "pcm_s16le",
          sample_rate: this.sampleRate,
        },
        language: this.language,
        context_id: contextId,
        continue: false,
        flush: true,
        add_timestamps: false,
      }),
      contextId,
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const dispose of this.disposers.splice(0)) dispose();
    this.connResolver = null;
    this.connRejecter = null;
    this.ready = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.bus = null;
  }

  private async connect(): Promise<void> {
    const { default: WebSocket } = await import("ws");
    const params = new URLSearchParams({
      api_key: this.apiKey,
      cartesia_version: "2024-06-10",
    });
    const url = `wss://api.cartesia.ai/tts/websocket?${params.toString()}`;

    this.ws = new WebSocket(url);
    this.ready = false;

    this.ws.on("open", () => {
      this.ready = true;
      this.connResolver?.();
      this.connResolver = null;
      this.connRejecter = null;
    });

    this.ws.on("message", (data: import("ws").RawData) => {
      const msg = JSON.parse(data.toString());
      const contextId = typeof msg.context_id === "string" ? msg.context_id : "";
      if (msg.data) {
        const audioBytes = Buffer.from(msg.data, "base64");
        const packet: TextToSpeechAudioPacket = {
          kind: "tts.audio",
          contextId,
          timestampMs: Date.now(),
          audio: new Uint8Array(audioBytes),
        };
        this.bus?.push(Route.Main, packet);
      }
      if (msg.done) {
        const packet: TextToSpeechEndPacket = {
          kind: "tts.end",
          contextId,
          timestampMs: Date.now(),
        };
        this.bus?.push(Route.Main, packet);
      }
    });

    this.ws.on("error", (err: Error) => {
      this.ready = false;
      this.connRejecter?.(err);
      this.connResolver = null;
      this.connRejecter = null;
      this.emitError("", err);
    });

    this.ws.on("close", () => {
      this.ready = false;
    });
  }

  private async sendWithRetry(payload: string, contextId: string): Promise<void> {
    for (let attempt = 1; attempt <= this.retryConfig.maxAttempts; attempt += 1) {
      try {
        await this.ensureReady();
        if (!this.ws || this.ws.readyState !== (this.ws as import("ws").WebSocket).OPEN) {
          throw new Error("Cartesia TTS WebSocket is not open");
        }
        this.ws.send(payload);
        return;
      } catch (err) {
        const category = categorizeTtsError(err);
        const recoverable = isRecoverable(category);
        if (!recoverable || attempt >= this.retryConfig.maxAttempts) {
          this.emitError(contextId, err instanceof Error ? err : new Error(String(err)));
          return;
        }

        this.bus?.push(Route.Background, {
          kind: "metric.conversation",
          contextId,
          timestampMs: Date.now(),
          name: "tts.retry",
          value: String(attempt + 1),
        });
        await this.reconnect();
        await waitForRetryDelay(attempt, this.retryConfig);
      }
    }
  }

  private async ensureReady(): Promise<void> {
    if (this.ready) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Cartesia TTS WebSocket connect timeout"));
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

  private async reconnect(): Promise<void> {
    if (this.closed) return;
    try {
      this.ws?.close();
    } catch {
      // best effort
    }
    await this.connect();
  }

  private emitError(contextId: string, err: Error): void {
    const category = categorizeTtsError(err);
    const packet: TtsErrorPacket = {
      kind: "tts.error",
      contextId,
      timestampMs: Date.now(),
      component: "tts" as const,
      category,
      cause: err,
      isRecoverable: isRecoverable(category),
    };
    this.bus?.push(Route.Critical, packet);
  }
}
