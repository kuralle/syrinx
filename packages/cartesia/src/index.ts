// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Cartesia TTS Plugin
//
// The streaming lifecycle lives in @kuralle-syrinx/tts-core. This file is the Cartesia wire
// protocol: per-context attribution (the provider echoes `context_id`), the speak/flush/cancel
// JSON frames, and the inbound decode of base64 audio + word timestamps + the `done` flag.
// Cartesia ships whole PCM16 frames, so it validates alignment in `decode` (erroring on an
// odd-length payload) rather than relying on the engine's streaming carry.

import {
  Route,
  assertAudioFormat,
  assertAudioPayload,
  optionalStringConfig,
  readProviderRetryConfig,
  requireStringConfig,
  type AudioFormat,
  type PipelineBus,
  type PluginConfig,
  type TextToSpeechWordTimestampsPacket,
  type TtsWordTimestamp,
  type VoicePlugin,
} from "@kuralle-syrinx/core";
import {
  attributionKey,
  defaultNodeSocketFactory,
  startStreamingTtsSession,
  type AttributionKey,
  type StreamingTtsSession,
  type WireEvent,
  type WireProtocol,
} from "@kuralle-syrinx/tts-core";
import type { SocketData, SocketFactory } from "@kuralle-syrinx/ws";

const KEEP_ALIVE_INTERVAL_MS = 10_000;

interface CartesiaWireConfig {
  readonly modelId: string;
  readonly voiceId: string;
  readonly sampleRate: number;
  readonly language: string;
  readonly audioFormat: AudioFormat;
}

class CartesiaWireProtocol implements WireProtocol {
  constructor(private readonly cfg: CartesiaWireConfig) {}

  attributionFor(contextId: string): { key: AttributionKey; contextId: string } {
    return { key: attributionKey(contextId), contextId };
  }

  encodeText(key: AttributionKey, text: string): SocketData[] {
    return [
      JSON.stringify({
        model_id: this.cfg.modelId,
        transcript: text,
        voice: { mode: "id", id: this.cfg.voiceId },
        output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: this.cfg.sampleRate },
        language: this.cfg.language,
        context_id: key || crypto.randomUUID(),
        continue: true,
        add_timestamps: true,
      }),
    ];
  }

  encodeFinish(contextId: string, activeKeys: readonly AttributionKey[]): SocketData[] {
    if (activeKeys.length === 0) return [];
    return [
      JSON.stringify({
        model_id: this.cfg.modelId,
        transcript: "",
        voice: { mode: "id", id: this.cfg.voiceId },
        output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: this.cfg.sampleRate },
        language: this.cfg.language,
        context_id: contextId,
        continue: false,
        flush: true,
      }),
    ];
  }

  encodeCancel(key: AttributionKey): SocketData[] {
    return [JSON.stringify({ context_id: key, cancel: true })];
  }

  encodeClose(): SocketData[] {
    return [];
  }

  decode(data: SocketData): WireEvent[] {
    if (typeof data !== "string") return []; // Cartesia frames are JSON text
    const msg = JSON.parse(data) as Record<string, unknown>; // parse failure → engine fails all contexts
    const contextId = typeof msg["context_id"] === "string" ? msg["context_id"] : "";
    const key = attributionKey(contextId);

    if (msg["type"] === "error" || isErrorStatusCode(msg["status_code"])) {
      // A `done:true` error frame both reports the error AND ends the context.
      return [{ type: "error", key: contextId ? key : null, error: cartesiaProviderError(msg), endsContext: msg["done"] === true }];
    }

    const events: WireEvent[] = [];
    if (msg["type"] === "timestamps") {
      const words = parseWordTimestamps(msg["word_timestamps"]);
      if (contextId && words.length > 0) {
        events.push({
          type: "sideband",
          key,
          route: Route.Main,
          build: (ctxId, timestampMs) =>
            ({ kind: "tts.word_timestamps", contextId: ctxId, timestampMs, words } satisfies TextToSpeechWordTimestampsPacket),
        });
      }
    }
    // Audio arrives as non-empty base64 `data`; control frames such as `flush_done` carry an
    // empty `data` and must not be decoded as audio.
    if (typeof msg["data"] === "string" && msg["data"].length > 0) {
      try {
        const bytes = new Uint8Array(decodeStrictBase64(msg["data"], "Cartesia TTS provider audio data"));
        assertAudioPayload(this.cfg.audioFormat, bytes);
        events.push({ type: "audio", key, pcm: bytes });
      } catch (err) {
        events.push({ type: "error", key, error: err instanceof Error ? err : new Error(String(err)) });
      }
    }
    if (msg["done"] === true) events.push({ type: "context_end", key });
    return events;
  }
}

export class CartesiaTTSPlugin implements VoicePlugin {
  // socketFactory is injectable so the same plugin runs on Node (default) or
  // Cloudflare Workers (pass createWorkersSocket).
  constructor(private readonly socketFactory?: SocketFactory) {}

  private session: StreamingTtsSession | null = null;

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    const apiKey = requireStringConfig(config, "api_key");
    const voiceId = optionalStringConfig(config, "voice_id") ?? "c2ac25f9-ecc4-4f56-9095-651354df60c0";
    const modelId = optionalStringConfig(config, "model_id") ?? "sonic-3";
    const endpointUrl = optionalStringConfig(config, "endpoint_url") ?? "wss://api.cartesia.ai/tts/websocket";
    const apiVersion = optionalStringConfig(config, "cartesia_version") ?? "2024-06-10";
    const sampleRate = (config["sample_rate"] as number) ?? 16000;
    const language = optionalStringConfig(config, "language") ?? "en";
    const audioFormat: AudioFormat = { encoding: "pcm_s16le", sampleRateHz: sampleRate, channels: 1 };
    assertAudioFormat(audioFormat);

    this.session = await startStreamingTtsSession(bus, {
      protocol: new CartesiaWireProtocol({ modelId, voiceId, sampleRate, language, audioFormat }),
      provider: { name: "cartesia", model: modelId, region: "global" },
      format: audioFormat,
      sampleRateHz: sampleRate,
      url: () => {
        const params = new URLSearchParams({ cartesia_version: apiVersion });
        const separator = endpointUrl.includes("?") ? "&" : "?";
        return `${endpointUrl}${separator}${params.toString()}`;
      },
      headers: { "X-API-Key": apiKey },
      retry: readProviderRetryConfig(config),
      finishTimeoutMs: readNonNegativeInteger(config["finish_timeout_ms"], 2000),
      metricPrefix: "tts.cartesia",
      replayMetrics: true,
      socketFactory: this.socketFactory ?? (await defaultNodeSocketFactory()),
      replayBufferSize: (config["replay_buffer_size"] as number) ?? 32,
      keepAliveIntervalMs: KEEP_ALIVE_INTERVAL_MS,
    });
  }

  async close(): Promise<void> {
    await this.session?.dispose();
    this.session = null;
  }
}

function isErrorStatusCode(value: unknown): boolean {
  return typeof value === "number" && value >= 400;
}

function cartesiaProviderError(msg: Record<string, unknown>): Error {
  const title = typeof msg["title"] === "string" ? msg["title"] : "Cartesia TTS provider error";
  const message = typeof msg["message"] === "string" ? msg["message"] : "";
  const error = typeof msg["error"] === "string" ? msg["error"] : "";
  const errorCode = typeof msg["error_code"] === "string" ? msg["error_code"] : "";
  const statusCode = typeof msg["status_code"] === "number" ? `status ${String(msg["status_code"])}` : "";
  const details = [message, error, errorCode, statusCode].filter((part) => part.length > 0).join(" ");
  return new Error(details ? `${title}: ${details}` : title);
}

function decodeStrictBase64(value: string, name: string): Buffer {
  const normalized = value.replace(/\s+/g, "");
  if (normalized.length === 0 || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error(`${name} must be valid base64`);
  }
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.toString("base64") !== normalized) {
    throw new Error(`${name} must be valid base64`);
  }
  return decoded;
}

function parseWordTimestamps(value: unknown): TtsWordTimestamp[] {
  if (value === null || typeof value !== "object") return [];
  const raw = value as Record<string, unknown>;
  const rawWords = Array.isArray(raw["words"]) ? raw["words"] : [];
  const rawStarts = Array.isArray(raw["start"]) ? raw["start"] : [];
  const rawEnds = Array.isArray(raw["end"]) ? raw["end"] : [];
  const count = Math.min(rawWords.length, rawStarts.length, rawEnds.length);
  const words: TtsWordTimestamp[] = [];
  for (let i = 0; i < count; i += 1) {
    const word = rawWords[i];
    const start = rawStarts[i];
    const end = rawEnds[i];
    if (typeof word !== "string" || typeof start !== "number" || typeof end !== "number") continue;
    words.push({ word, startMs: Math.round(start * 1000), endMs: Math.round(end * 1000) });
  }
  return words;
}

function readNonNegativeInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const integer = Math.floor(value);
  return integer >= 0 ? integer : fallback;
}
