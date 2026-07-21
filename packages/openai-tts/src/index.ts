// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — OpenAI-Compatible HTTP Streaming TTS Plugin
//
// Generic plugin for any OpenAI-compatible POST /audio/speech endpoint with
// stream:true returning raw mono s16le PCM. Configurable base_url, api_key,
// model, voice, response_format, source_sample_rate_hz, sample_rate, tempo,
// and extra_body. Supports WSOLA time-stretch for tempo control.

import type { PipelineBus } from "@kuralle-syrinx/core";
import {
  Route,
  StreamingPcm16Resampler,
  type PluginConfig,
  type TextToSpeechAudioPacket,
  type TextToSpeechEndPacket,
  type TtsErrorPacket,
  type VoicePlugin,
  categorizeTtsError,
  isRecoverable,
  optionalStringConfig,
} from "@kuralle-syrinx/core";

import { WsolaTimeStretch } from "./wsola.js";
export { WsolaTimeStretch } from "./wsola.js";

const EMPTY = new Uint8Array(0);
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini-tts";
const DEFAULT_RESPONSE_FORMAT = "pcm";
const DEFAULT_SOURCE_SAMPLE_RATE_HZ = 24_000;
const DEFAULT_ENGINE_RATE_HZ = 16_000;
const DEFAULT_TEMPO = 1.0;
const TEMPO_MIN = 0.5;
const TEMPO_MAX = 1.5;

export class OpenAICompatibleTTSPlugin implements VoicePlugin {
  private bus: PipelineBus | null = null;
  private baseUrl = DEFAULT_BASE_URL;
  private apiKey = "";
  private model = DEFAULT_MODEL;
  private voice: string | undefined;
  private responseFormat = DEFAULT_RESPONSE_FORMAT;
  private sourceSampleRateHz = DEFAULT_SOURCE_SAMPLE_RATE_HZ;
  private sampleRate = DEFAULT_ENGINE_RATE_HZ;
  private tempo = DEFAULT_TEMPO;
  private extraBody: Record<string, unknown> | undefined;
  private disposers: Array<() => void> = [];
  private inflight = new Set<AbortController>();

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    this.baseUrl = stripTrailingSlash(
      optionalStringConfig(config, "base_url") ??
        processEnv("OPENAI_BASE_URL") ??
        DEFAULT_BASE_URL,
    );
    this.apiKey =
      optionalStringConfig(config, "api_key") ?? processEnv("OPENAI_API_KEY") ?? "";
    this.model = optionalStringConfig(config, "model") ?? DEFAULT_MODEL;
    this.voice = optionalStringConfig(config, "voice");
    this.responseFormat = optionalStringConfig(config, "response_format") ?? DEFAULT_RESPONSE_FORMAT;
    this.sourceSampleRateHz = readPositiveInteger(
      config["source_sample_rate_hz"],
      DEFAULT_SOURCE_SAMPLE_RATE_HZ,
    );
    this.sampleRate = readPositiveInteger(config["sample_rate"], DEFAULT_ENGINE_RATE_HZ);
    this.tempo = readClampedTempo(config["tempo"], DEFAULT_TEMPO);
    this.extraBody = readPlainObject(config["extra_body"]);

    this.disposers.push(
      bus.on("tts.text", async (pkt: unknown) => {
        const textPkt = pkt as { text: string; contextId: string };
        await this.synth(textPkt.text, textPkt.contextId);
      }),
      bus.on("interrupt.tts", () => {
        this.abortInflight();
      }),
    );
  }

  async close(): Promise<void> {
    this.abortInflight();
    for (const dispose of this.disposers.splice(0)) dispose();
    this.bus = null;
  }

  async prewarm(): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const headers: Record<string, string> = {};
      if (this.apiKey) {
        headers["Authorization"] = `Bearer ${this.apiKey}`;
      }
      await fetch(`${this.baseUrl}/models`, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
    } catch {
      // best-effort
    } finally {
      clearTimeout(timeout);
    }
  }

  private abortInflight(): void {
    for (const controller of this.inflight) {
      controller.abort();
    }
    this.inflight.clear();
  }

  private async synth(text: string, contextId: string): Promise<void> {
    if (!text.trim()) return;

    const controller = new AbortController();
    this.inflight.add(controller);

    const speechUrl = `${this.baseUrl}/audio/speech`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const body: Record<string, unknown> = {
      model: this.model,
      input: text,
      response_format: this.responseFormat,
      stream: true,
      ...this.extraBody,
    };
    if (this.voice !== undefined) {
      body.voice = this.voice;
    }

    try {
      const response = await fetch(speechUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        if (response.status === 503) {
          console.error(
            "[openai-tts] cold start (HTTP 503) — provider may be warming up; keep-warm required for production",
          );
        }
        const err = Object.assign(
          new Error(
            `OpenAI-compatible TTS HTTP ${String(response.status)}: ${response.statusText || "request failed"}`,
          ),
          { status: response.status },
        );
        this.emitError(contextId, err);
        return;
      }

      const responseBody = response.body;
      if (!responseBody) {
        this.emitError(contextId, new Error("OpenAI-compatible TTS response body is null"));
        return;
      }

      const reader = responseBody.getReader();
      const resampler = new StreamingPcm16Resampler(this.sourceSampleRateHz, this.sampleRate);
      const stretch =
        Math.abs(this.tempo - 1) >= 1e-6
          ? new WsolaTimeStretch(this.tempo, this.sampleRate)
          : null;
      let carry: Uint8Array = EMPTY;

      while (true) {
        if (controller.signal.aborted) return;
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;

        const frame = value instanceof Uint8Array ? value : new Uint8Array(value);
        const buf = carry.byteLength === 0 ? frame : concatBytes(carry, frame);
        const evenLen = buf.byteLength - (buf.byteLength % 2);
        if (evenLen > 0) {
          const pcmBytes = buf.subarray(0, evenLen);
          const samples = bytesToInt16LE(pcmBytes);
          const resampled = resampler.process(samples);
          const stretched = stretch ? stretch.process(resampled) : resampled;
          if (stretched.length > 0) {
            this.emitAudio(contextId, stretched);
          }
        }
        carry = evenLen < buf.byteLength ? buf.subarray(evenLen) : EMPTY;
      }

      if (controller.signal.aborted) return;
      if (stretch) {
        const tail = stretch.flush();
        if (tail.length > 0) {
          this.emitAudio(contextId, tail);
        }
      }
      this.emitUsage(contextId, text.length);
      this.emitEnd(contextId);
    } catch (err) {
      if (isAbortError(err) || controller.signal.aborted) return;
      this.emitError(contextId, err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.inflight.delete(controller);
    }
  }

  private emitError(contextId: string, err: Error): void {
    const category = categorizeTtsError(err);
    const packet: TtsErrorPacket = {
      kind: "tts.error",
      contextId,
      timestampMs: Date.now(),
      component: "tts",
      category,
      cause: err,
      isRecoverable: isRecoverable(category),
    };
    this.bus?.push(Route.Critical, packet);
  }

  private emitAudio(contextId: string, samples: Int16Array): void {
    const audio = int16ToBytes(samples);
    const packet: TextToSpeechAudioPacket = {
      kind: "tts.audio",
      contextId,
      timestampMs: Date.now(),
      audio,
      sampleRateHz: this.sampleRate,
      provider: { name: "openai", model: this.model, cancelled: false },
    };
    this.bus?.push(Route.Main, packet);
  }

  private emitUsage(contextId: string, characters: number): void {
    if (characters <= 0) return;
    this.bus?.push(Route.Background, {
      kind: "usage.recorded",
      contextId,
      timestampMs: Date.now(),
      stage: "tts",
      provider: "openai",
      model: this.model,
      characters,
    });
  }

  private emitEnd(contextId: string): void {
    this.bus?.push(Route.Main, {
      kind: "tts.end",
      contextId,
      timestampMs: Date.now(),
    } satisfies TextToSpeechEndPacket);
  }
}

function processEnv(key: string): string | undefined {
  try {
    const value = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
      ?.env?.[key];
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function readPositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const integer = Math.floor(value);
  return integer > 0 ? integer : fallback;
}

function readClampedTempo(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value < TEMPO_MIN) return TEMPO_MIN;
  if (value > TEMPO_MAX) return TEMPO_MAX;
  return value;
}

function readPlainObject(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

/** Copy into an owned ArrayBuffer so Int16Array is always 2-byte aligned. */
function bytesToInt16LE(bytes: Uint8Array): Int16Array {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return new Int16Array(ab);
}

function int16ToBytes(samples: Int16Array): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}
