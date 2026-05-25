// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Gemini TTS Plugin
//
// Uses Google Gemini's multimodal API (`responseModalities: ['AUDIO']`) to
// synthesize speech. Non-streaming (chunked) — sends full text, receives
// complete audio. Modeled after LiveKit's google.gemini.TTS implementation.
//
// Reference: LiveKit agents-js plugins/google/src/beta/gemini_tts.ts
// Reference: Rapida transformer/google/tts.go (GCP TTS API, not Gemini)

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

// =============================================================================
// Types
// =============================================================================

export type GeminiVoice =
  | "Kore"
  | "Puck"
  | "Charon"
  | "Fenrir"
  | "Leda"
  | "Aoede"
  | "Zephyr"
  | "Orus";

export type GeminiTTSModel =
  | "gemini-3.1-flash-tts-preview"
  | "gemini-2.5-flash-preview-tts"
  | "gemini-2.5-pro-preview-tts";

const DEFAULT_MODEL: GeminiTTSModel = "gemini-3.1-flash-tts-preview";
const DEFAULT_VOICE: GeminiVoice = "Kore";
const SAMPLE_RATE = 24000;

// =============================================================================
// Plugin
// =============================================================================

export class GeminiTTSPlugin implements VoicePlugin {
  private bus: PipelineBus | null = null;
  private apiKey: string = "";
  private model: string = DEFAULT_MODEL;
  private voiceName: string = DEFAULT_VOICE;
  private abortController: AbortController | null = null;

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    this.apiKey = requireStringConfig(config, "api_key");
    this.model = optionalStringConfig(config, "model") ?? DEFAULT_MODEL;
    this.voiceName = optionalStringConfig(config, "voice_name") ?? DEFAULT_VOICE;

    // Listen for TTS text on the bus
    bus.on("tts.text", async (pkt: unknown) => {
      const textPkt = pkt as { text: string; contextId: string };
      await this.synthesize(textPkt.text, textPkt.contextId);
    });

    // Listen for TTS interrupts
    bus.on("interrupt.tts", () => {
      this.abortController?.abort();
      this.abortController = null;
    });
  }

  private async synthesize(text: string, contextId: string): Promise<void> {
    if (!text.trim() || !this.bus) return;

    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const start = Date.now();

    try {
      // Dynamic import — @google/genai is heavy, only load when used
      const { GoogleGenAI } = await import("@google/genai");

      const client = new GoogleGenAI({ apiKey: this.apiKey });

      const contents = [
        {
          role: "user" as const,
          parts: [{ text }],
        },
      ];

      const responseStream = await client.models.generateContentStream({
        model: this.model,
        contents,
        config: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: this.voiceName,
              },
            },
          },
          abortSignal: signal,
        },
      });

      let firstAudio = false;
      let audioChunks = 0;

      for await (const response of responseStream) {
        if (signal.aborted) return;

        const candidate = response.candidates?.[0];
        if (!candidate?.content?.parts) continue;

        for (const part of candidate.content.parts) {
          if (signal.aborted) return;

          if (part.inlineData?.data && part.inlineData.mimeType?.startsWith("audio/")) {
            const audioBytes = Buffer.from(part.inlineData.data, "base64");
            const audioUint8 = new Uint8Array(audioBytes);

            if (!firstAudio) {
              firstAudio = true;
            }

            this.bus?.push(Route.Main, {
              kind: "tts.audio",
              contextId,
              timestampMs: Date.now(),
              audio: audioUint8,
            });
            audioChunks++;
          }
        }
      }

      if (!signal.aborted && audioChunks > 0) {
        this.bus?.push(Route.Main, {
          kind: "tts.end",
          contextId,
          timestampMs: Date.now(),
        });
      }
    } catch (err) {
      if (signal.aborted) return;

      const category = categorizeTtsError(err);
      this.bus?.push(Route.Critical, {
        kind: "tts.error",
        contextId,
        timestampMs: Date.now(),
        component: "tts" as const,
        category,
        cause: err instanceof Error ? err : new Error(String(err)),
        isRecoverable: isRecoverable(category),
      });
    }
  }

  /** Flush/cancel current synthesis (called on interrupt). */
  flush(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  async close(): Promise<void> {
    this.abortController?.abort();
    this.bus = null;
  }
}
