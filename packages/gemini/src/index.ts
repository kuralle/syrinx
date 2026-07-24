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

import type { PipelineBus } from "@kuralle-syrinx/core";
import {
  Route,
  type AudioFormat,
  type VoicePlugin,
  type PluginConfig,
  type TextToSpeechEndPacket,
  assertAudioFormat,
  assertAudioPayload,
  requireStringConfig,
  optionalStringConfig,
  categorizeTtsError,
  isRecoverable,
  readRetryConfig,
  waitForRetryDelay,
  type RetryConfig,
} from "@kuralle-syrinx/core";

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
const DEFAULT_SAMPLE_RATE = 24000;

// =============================================================================
// Plugin
// =============================================================================

export class GeminiTTSPlugin implements VoicePlugin {
  private bus: PipelineBus | null = null;
  private apiKey: string = "";
  private model: string = DEFAULT_MODEL;
  private voiceName: string = DEFAULT_VOICE;
  private instruction = "";
  private languageCode: string | undefined;
  private timeoutMs = 45_000;
  private sampleRate = DEFAULT_SAMPLE_RATE;
  private generationConfig: Record<string, unknown> | undefined;
  // One controller per in-flight turn. A single shared field let a second turn's
  // synthesize() overwrite the first's controller, so a barge-in on turn N aborted
  // only turn N+1 and turn N's stale audio could still stream after the interrupt.
  private readonly abortControllers = new Map<string, AbortController>();
  private textByContextId = new Map<string, string>();
  /** Synthesized character counts per contextId — billed on successful tts.end. */
  private charactersByContextId = new Map<string, number>();
  private retryConfig: RetryConfig = readRetryConfig({});
  private disposers: Array<() => void> = [];
  private audioFormat: AudioFormat = {
    encoding: "pcm_s16le",
    sampleRateHz: DEFAULT_SAMPLE_RATE,
    channels: 1,
  };

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    this.apiKey = requireStringConfig(config, "api_key");
    this.model = optionalStringConfig(config, "model") ?? DEFAULT_MODEL;
    this.voiceName = optionalStringConfig(config, "voice_name") ?? DEFAULT_VOICE;
    this.instruction = optionalStringConfig(config, "instruction") ?? "";
    this.languageCode =
      optionalStringConfig(config, "language_code") ?? optionalStringConfig(config, "language");
    this.timeoutMs = readPositiveInteger(config["timeout_ms"], 45_000);
    this.sampleRate = readPositiveInteger(config["sample_rate"], DEFAULT_SAMPLE_RATE);
    this.generationConfig = readPlainObject(config["generation_config"]);
    this.retryConfig = readRetryConfig(config);
    this.audioFormat = { encoding: "pcm_s16le", sampleRateHz: this.sampleRate, channels: 1 };
    assertAudioFormat(this.audioFormat);

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
          this.charactersByContextId.delete(donePkt.contextId);
          this.emitEnd(donePkt.contextId);
          return;
        }
        this.charactersByContextId.set(donePkt.contextId, text.length);
        await this.synthesize(text, donePkt.contextId);
      }),

      // Listen for TTS interrupts — abort only the interrupted turn's synthesis.
      bus.on("interrupt.tts", (pkt) => {
        const ctxId = (pkt as { contextId: string }).contextId;
        this.charactersByContextId.delete(ctxId);
        const controller = this.abortControllers.get(ctxId);
        if (controller) {
          controller.abort();
          this.abortControllers.delete(ctxId);
        }
      }),
    );
  }

  private async synthesize(text: string, contextId: string): Promise<void> {
    if (!this.bus) return;

    const controller = new AbortController();
    this.abortControllers.set(contextId, controller);
    const signal = controller.signal;

    try {
      await this.synthesizeWithRetry(text, contextId, signal);
    } finally {
      // Only clear if still ours — an interrupt may have already removed it.
      if (this.abortControllers.get(contextId) === controller) {
        this.abortControllers.delete(contextId);
      }
    }
  }

  private async synthesizeWithRetry(text: string, contextId: string, signal: AbortSignal): Promise<void> {
    for (let attempt = 1; attempt <= this.retryConfig.maxAttempts; attempt += 1) {
      try {
        const audioChunks = await this.synthesizeOnce(text, contextId, signal);
        if (signal.aborted) {
          this.charactersByContextId.delete(contextId);
          return;
        }
        if (audioChunks > 0) {
          this.emitEnd(contextId);
          return;
        }
        throw new Error("Gemini TTS returned no audio chunks");
      } catch (err) {
        if (signal.aborted) {
          this.charactersByContextId.delete(contextId);
          return;
        }

        const category = categorizeTtsError(err);
        const recoverable = isRecoverable(category);
        if (!recoverable || attempt >= this.retryConfig.maxAttempts) {
          this.charactersByContextId.delete(contextId);
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
    const characters = this.charactersByContextId.get(contextId) ?? 0;
    this.charactersByContextId.delete(contextId);
    if (characters > 0) {
      this.bus?.push(Route.Background, {
        kind: "usage.recorded",
        contextId,
        timestampMs: Date.now(),
        stage: "tts",
        provider: "gemini",
        model: this.model,
        characters,
      });
    }
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

    const speechConfig: Record<string, unknown> = {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: this.voiceName,
        },
      },
    };
    if (this.languageCode) speechConfig["languageCode"] = this.languageCode;

    const response = await withTimeout(
      client.models.generateContent({
        model: this.model,
        contents: [{ parts: [{ text: this.instruction ? `${this.instruction}: ${text}` : text }] }],
        config: {
          responseModalities: ["AUDIO"],
          speechConfig,
          ...this.generationConfig,
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
        assertAudioPayload(this.audioFormat, audioUint8);

        this.bus?.push(Route.Main, {
          kind: "tts.audio",
          contextId,
          timestampMs: Date.now(),
          audio: audioUint8,
          sampleRateHz: this.sampleRate,
        });
        audioChunks++;
      }
    }

    return audioChunks;
  }

  /** Flush/cancel all in-flight synthesis (called on interrupt/shutdown). */
  flush(): void {
    for (const controller of this.abortControllers.values()) controller.abort();
    this.abortControllers.clear();
    this.charactersByContextId.clear();
  }

  async close(): Promise<void> {
    this.flush();
    for (const dispose of this.disposers.splice(0)) dispose();
    this.textByContextId.clear();
    this.charactersByContextId.clear();
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

function readPlainObject(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}
