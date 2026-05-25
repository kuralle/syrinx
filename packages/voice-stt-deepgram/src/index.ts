// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Deepgram STT Plugin
//
// Implements VoicePlugin contract. Receives PipelineBus, pushes STT results
// and categorized errors into the bus.

import type { PipelineBus } from "@asyncdot/voice";
import {
  Route,
  type VoicePlugin,
  type PluginConfig,
  requireStringConfig,
  categorizeSttError,
  isRecoverable,
} from "@asyncdot/voice";

// =============================================================================
// Plugin
// =============================================================================

export class DeepgramSTTPlugin implements VoicePlugin {
  private bus: PipelineBus | null = null;
  private ws: import("ws").WebSocket | null = null;
  private ready = false;
  private connResolver: (() => void) | null = null;

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    const apiKey = requireStringConfig(config, "api_key");
    const sampleRate = (config["sample_rate"] as number) ?? 16000;

    const { default: WebSocket } = await import("ws");
    const url = `wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=${sampleRate}&interim_results=true&endpointing=800&smart_format=true`;

    this.ws = new WebSocket(url, {
      headers: { Authorization: `Token ${apiKey}` },
    });

    this.ws.on("open", () => {
      this.ready = true;
      this.connResolver?.();
    });

    this.ws.on("message", (data: import("ws").RawData) => {
      const msg = JSON.parse(data.toString());
      const alt = msg.channel?.alternatives?.[0];
      if (!alt || !alt.transcript) return;

      if (msg.is_final) {
        this.bus?.push(Route.Main, {
          kind: "stt.result",
          contextId: "", // Set by session manager
          timestampMs: Date.now(),
          text: alt.transcript,
          confidence: alt.confidence ?? 0,
        });
      } else {
        this.bus?.push(Route.Main, {
          kind: "stt.interim",
          contextId: "",
          timestampMs: Date.now(),
          text: alt.transcript,
        });
      }
    });

    this.ws.on("error", (err: Error) => {
      const category = categorizeSttError(err);
      this.bus?.push(Route.Critical, {
        kind: "stt.error",
        contextId: "",
        timestampMs: Date.now(),
        component: "stt" as const,
        category,
        cause: err,
        isRecoverable: isRecoverable(category),
      });
    });
  }

  async sendAudio(audio: Uint8Array): Promise<void> {
    if (!this.ready) {
      await new Promise<void>((resolve) => {
        this.connResolver = resolve;
      });
    }
    this.ws?.send(audio);
  }

  async close(): Promise<void> {
    if (this.ws) {
      this.ws.send(Buffer.from(JSON.stringify({ type: "CloseStream" })));
      this.ws.close();
      this.ws = null;
    }
    this.bus = null;
  }
}
