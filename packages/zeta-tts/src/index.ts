// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Zeta HTTP Streaming TTS Plugin
//
// OpenAI-compatible POST /v1/audio/speech with stream:true returns raw 48 kHz
// mono s16le PCM. We resample to the engine rate and emit tts.audio / tts.end
// on the bus. Transport is fetch streaming (not WebSocket); structure mirrors
// Deepgram TTS (odd-byte carry, interrupt abort, recoverable 503 cold-start).

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

const EMPTY = new Uint8Array(0);
const SOURCE_SAMPLE_RATE_HZ = 48_000;
const DEFAULT_ENGINE_RATE_HZ = 16_000;
const DEFAULT_NUM_STEPS = 8;
const DEFAULT_BASE_URL =
  "https://asyncdotengineering--zeta-tts-api-zetattsapi.us-east.modal.direct";

export class ZetaTTSPlugin implements VoicePlugin {
  private bus: PipelineBus | null = null;
  private baseUrl = DEFAULT_BASE_URL;
  private apiKey = "";
  private sampleRate = DEFAULT_ENGINE_RATE_HZ;
  private numSteps = DEFAULT_NUM_STEPS;
  private disposers: Array<() => void> = [];
  private inflight = new Set<AbortController>();

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    this.baseUrl = stripTrailingSlash(
      optionalStringConfig(config, "endpoint_url") ??
        processEnv("ZETA_BASE_URL") ??
        DEFAULT_BASE_URL,
    );
    this.apiKey =
      optionalStringConfig(config, "api_key") ?? processEnv("ZETA_API_KEY") ?? "";
    this.sampleRate = readPositiveInteger(config["sample_rate"], DEFAULT_ENGINE_RATE_HZ);
    this.numSteps = readPositiveInteger(config["num_steps"], DEFAULT_NUM_STEPS);

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

    const speechUrl = `${this.baseUrl}/v1/audio/speech`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    try {
      const response = await fetch(speechUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "zeta",
          input: text,
          response_format: "pcm",
          stream: true,
          task_type: "Base",
          num_steps: this.numSteps,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        if (response.status === 503) {
          console.error(
            "[zeta-tts] cold start (HTTP 503) — Modal app may be asleep; keep-warm required for production",
          );
        }
        const err = Object.assign(
          new Error(`Zeta TTS HTTP ${String(response.status)}: ${response.statusText || "request failed"}`),
          { status: response.status },
        );
        this.emitError(contextId, err);
        return;
      }

      const body = response.body;
      if (!body) {
        this.emitError(contextId, new Error("Zeta TTS response body is null"));
        return;
      }

      const reader = body.getReader();
      const resampler = new StreamingPcm16Resampler(SOURCE_SAMPLE_RATE_HZ, this.sampleRate);
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
          if (resampled.length > 0) {
            const audio = int16ToBytes(resampled);
            const packet: TextToSpeechAudioPacket = {
              kind: "tts.audio",
              contextId,
              timestampMs: Date.now(),
              audio,
              sampleRateHz: this.sampleRate,
              provider: { name: "zeta", model: "zeta", cancelled: false },
            };
            this.bus?.push(Route.Main, packet);
          }
        }
        carry = evenLen < buf.byteLength ? buf.subarray(evenLen) : EMPTY;
      }

      if (controller.signal.aborted) return;
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
