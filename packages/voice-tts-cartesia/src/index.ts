// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Cartesia TTS Plugin
//
// Implements VoicePlugin contract. Receives PipelineBus, pushes TTS audio
// and categorized errors into the bus.

import type { PipelineBus } from "@asyncdot/voice";
import {
  Route,
  type VoicePlugin,
  type PluginConfig,
  requireStringConfig,
  optionalStringConfig,
  categorizeTtsError,
  isRecoverable,
} from "@asyncdot/voice";
import { randomUUID } from "node:crypto";

export class CartesiaTTSPlugin implements VoicePlugin {
  private bus: PipelineBus | null = null;
  private ws: import("ws").WebSocket | null = null;
  private ready = false;
  private connResolver: (() => void) | null = null;

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    const apiKey = requireStringConfig(config, "api_key");
    const voiceId = optionalStringConfig(config, "voice_id") ?? "694f9389-aac1-45b6-b726-9d9369183238";
    const modelId = optionalStringConfig(config, "model_id") ?? "sonic-2";
    const sampleRate = (config["sample_rate"] as number) ?? 24000;

    const { default: WebSocket } = await import("ws");
    const params = new URLSearchParams({
      api_key: apiKey,
      cartesia_version: "2024-06-01",
    });
    const url = `wss://api.cartesia.ai/tts/websocket?${params.toString()}`;

    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.ready = true;
      this.connResolver?.();
    });

    this.ws.on("message", (data: import("ws").RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.data) {
        const audioBytes = Buffer.from(msg.data, "base64");
        this.bus?.push(Route.Main, {
          kind: "tts.audio",
          contextId: "",
          timestampMs: Date.now(),
          audio: new Uint8Array(audioBytes),
        });
      }
      if (msg.done) {
        this.bus?.push(Route.Main, {
          kind: "tts.end",
          contextId: "",
          timestampMs: Date.now(),
        });
      }
    });

    this.ws.on("error", (err: Error) => {
      const category = categorizeTtsError(err);
      this.bus?.push(Route.Critical, {
        kind: "tts.error",
        contextId: "",
        timestampMs: Date.now(),
        component: "tts" as const,
        category,
        cause: err,
        isRecoverable: isRecoverable(category),
      });
    });

    // Listen for TTS text on the bus
    this.bus.on("tts.text", async (pkt: unknown) => {
      const textPkt = pkt as { text: string };
      await this.sendText(textPkt.text);
    });

    this.bus.on("interrupt.tts", () => {
      this.flush();
    });

    // Store config for sendText
    (this as Record<string, unknown>)._voiceId = voiceId;
    (this as Record<string, unknown>)._modelId = modelId;
    (this as Record<string, unknown>)._sampleRate = sampleRate;
  }

  async sendText(text: string): Promise<void> {
    if (!text.trim()) return;
    if (!this.ready) {
      await new Promise<void>((r) => { this.connResolver = r; });
    }
    const voiceId = (this as Record<string, unknown>)._voiceId as string;
    const modelId = (this as Record<string, unknown>)._modelId as string;
    const sampleRate = (this as Record<string, unknown>)._sampleRate as number;

    this.ws?.send(JSON.stringify({
      model_id: modelId,
      transcript: text,
      voice: { mode: "id", id: voiceId },
      output_format: {
        container: "raw",
        encoding: "pcm_s16le",
        sample_rate: sampleRate,
      },
      language: "en",
      context_id: randomUUID(),
    }));
  }

  /** Flush/cancel current TTS generation (called on interrupt). */
  flush(): void {
    if (this.ws && this.ws.readyState === (this.ws as import("ws").WebSocket).OPEN) {
      this.ws.send(JSON.stringify({ type: "flush" }));
    }
  }

  async close(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.bus = null;
  }
}
