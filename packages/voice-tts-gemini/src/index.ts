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
  type TextToSpeechEndPacket,
  requireStringConfig,
  optionalStringConfig,
  categorizeTtsError,
  isRecoverable,
  readRetryConfig,
  waitForRetryDelay,
  type RetryConfig,
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
  private timeoutMs = 45_000;
  private abortController: AbortController | null = null;
  private textByContextId = new Map<string, string>();
  private retryConfig: RetryConfig = readRetryConfig({});
  private disposers: Array<() => void> = [];

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    this.apiKey = requireStringConfig(config, "api_key");
    this.model = optionalStringConfig(config, "model") ?? DEFAULT_MODEL;
    this.voiceName = optionalStringConfig(config, "voice_name") ?? DEFAULT_VOICE;
    this.timeoutMs = readPositiveInteger(config["timeout_ms"], 45_000);
    this.retryConfig = readRetryConfig(config);

    // Accumulate streaming text deltas; Gemini TTS returns chunked audio for
    // complete text, not true token-by-token low-latency streaming.
    this.disposers.push(
      bus.on("tts.text", (pkt: unknown) => {
        const textPkt = pkt as { text: string; contextId: string };
        const current = this.textByContextId.get(textPkt.contextId) ?? "";
        this.textByContextId.set(textPkt.contextId, current + textPkt.text);
      }),

      bus.on("tts.done", async (pkt: unknown) => {
        const donePkt = pkt as { text: string; contextId: string };
        const buffered = this.textByContextId.get(donePkt.contextId) ?? "";
        this.textByContextId.delete(donePkt.contextId);
        const text = donePkt.text || buffered;
        if (!text.trim()) {
          this.emitEnd(donePkt.contextId);
          return;
        }
        await this.synthesize(text, donePkt.contextId);
      }),

      // Listen for TTS interrupts
      bus.on("interrupt.tts", () => {
        this.abortController?.abort();
        this.abortController = null;
      }),
    );
  }

  private async synthesize(text: string, contextId: string): Promise<void> {
    if (!this.bus) return;

    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    for (let attempt = 1; attempt <= this.retryConfig.maxAttempts; attempt += 1) {
      try {
        const audioChunks = await this.synthesizeOnce(text, contextId, signal);
        if (!signal.aborted && audioChunks > 0) {
          this.bus?.push(Route.Main, {
            kind: "tts.end",
            contextId,
            timestampMs: Date.now(),
          });
        }
        if (!signal.aborted && audioChunks === 0) {
          throw new Error("Gemini TTS returned no audio chunks");
        }
        return;
      } catch (err) {
        if (signal.aborted) return;

        const category = categorizeTtsError(err);
        const recoverable = isRecoverable(category);
        if (!recoverable || attempt >= this.retryConfig.maxAttempts) {
          this.bus?.push(Route.Critical, {
            kind: "tts.error",
            contextId,
            timestampMs: Date.now(),
            component: "tts" as const,
            category,
            cause: err instanceof Error ? err : new Error(String(err)),
            isRecoverable: recoverable,
          });
          return;
        }

        this.bus?.push(Route.Background, {
          kind: "metric.conversation",
          contextId,
          timestampMs: Date.now(),
          name: "tts.retry",
          value: String(attempt + 1),
        });
        await waitForRetryDelay(attempt, this.retryConfig, signal);
      }
    }
  }

  private emitEnd(contextId: string): void {
    this.bus?.push(Route.Main, {
      kind: "tts.end",
      contextId,
      timestampMs: Date.now(),
    } satisfies TextToSpeechEndPacket);
  }

  private async synthesizeOnce(text: string, contextId: string, signal: AbortSignal): Promise<number> {
    // Dynamic import — @google/genai is heavy, only load when used
    const { GoogleGenAI } = await import("@google/genai");

    const client = new GoogleGenAI({ apiKey: this.apiKey });

    const response = await withTimeout(
      client.models.generateContent({
        model: this.model,
        contents: [{ parts: [{ text: `Read this aloud in a natural student-support phone voice: ${text}` }] }],
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
      }),
      this.timeoutMs,
      signal,
    );

    let audioChunks = 0;
    const candidate = response.candidates?.[0];
    if (!candidate?.content?.parts) return audioChunks;

    for (const part of candidate.content.parts) {
      if (signal.aborted) return audioChunks;

      if (part.inlineData?.data && part.inlineData.mimeType?.startsWith("audio/")) {
        const audioBytes = Buffer.from(part.inlineData.data, "base64");
        const audioUint8 = new Uint8Array(audioBytes);

        this.bus?.push(Route.Main, {
          kind: "tts.audio",
          contextId,
          timestampMs: Date.now(),
          audio: audioUint8,
          sampleRateHz: SAMPLE_RATE,
        });
        audioChunks++;
      }
    }

    return audioChunks;
  }

  /** Flush/cancel current synthesis (called on interrupt). */
  flush(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  async close(): Promise<void> {
    this.abortController?.abort();
    for (const dispose of this.disposers.splice(0)) dispose();
    this.textByContextId.clear();
    this.bus = null;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Gemini TTS aborted"));
      return;
    }

    const timeout = setTimeout(() => {
      reject(new Error(`Gemini TTS request timeout after ${String(timeoutMs)}ms`));
    }, timeoutMs);
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(new Error("Gemini TTS aborted"));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function readPositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const integer = Math.floor(value);
  return integer > 0 ? integer : fallback;
}
