// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Epsilon TTS Plugin (multiplexed WebSocket)
//
// The streaming lifecycle (per-request carry, refcount completion, finish-timeout, error
// mapping, cancellation, connection-loss failure) lives in @kuralle-syrinx/tts-core. This
// file is just the Epsilon wire protocol: how a `speak`/`cancel`/`eos` frame is encoded and
// how an inbound JSON/binary frame decodes to a domain event, keyed by `request_id`.

import {
  assertAudioFormat,
  optionalStringConfig,
  readProviderRetryConfig,
  requireStringConfig,
  type AudioFormat,
  type PipelineBus,
  type PluginConfig,
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

import { parseEpsilonBinaryFrame } from "./binary-frame.js";

const KEEP_ALIVE_INTERVAL_MS = 10_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 120_000;
const EPSILON_SAMPLE_RATE_HZ = 24_000;
const EPSILON_VOICES = ["sinhala", "english", "tamil"] as const;

export type EpsilonVoice = (typeof EPSILON_VOICES)[number];

export { parseEpsilonBinaryFrame, encodeEpsilonBinaryFrame } from "./binary-frame.js";
export type { ParsedEpsilonBinaryFrame } from "./binary-frame.js";

class EpsilonWireProtocol implements WireProtocol {
  private readonly seq = new Map<string, number>();

  constructor(private readonly voice: EpsilonVoice) {}

  attributionFor(contextId: string): { key: AttributionKey; contextId: string } {
    const n = this.seq.get(contextId) ?? 0;
    this.seq.set(contextId, n + 1);
    return { key: attributionKey(`${contextId}:${String(n)}`), contextId };
  }

  encodeText(key: AttributionKey, text: string): SocketData[] {
    return [JSON.stringify({ type: "speak", request_id: key, input: text, voice: this.voice })];
  }

  // Epsilon has no per-context finish frame: a context ends when all its requests report done.
  encodeFinish(): SocketData[] {
    return [];
  }

  encodeCancel(key: AttributionKey): SocketData[] {
    return [JSON.stringify({ type: "cancel", request_id: key })];
  }

  encodeClose(): SocketData[] {
    return [JSON.stringify({ type: "eos" })];
  }

  decode(data: SocketData, isBinary: boolean): WireEvent[] {
    if (isBinary && typeof data !== "string") {
      // Throws on truncated frames → the engine treats decode failures as fatal.
      const { requestId, pcm } = parseEpsilonBinaryFrame(data);
      return [{ type: "audio", key: attributionKey(requestId), pcm }];
    }
    if (typeof data !== "string") return [];
    const msg = JSON.parse(data) as Record<string, unknown>;
    const requestId = typeof msg["request_id"] === "string" ? msg["request_id"] : "";
    const key = requestId ? attributionKey(requestId) : null;
    switch (typeof msg["type"] === "string" ? msg["type"] : "") {
      case "done":
        // One request finished; the context ends when all its requests are done (refcount).
        return key ? [{ type: "utterance_end", key }] : [];
      case "cancelled":
        return key ? [{ type: "cancelled", key }] : [];
      case "error":
        return [{ type: "error", key, error: epsilonProviderError(msg) }];
      default:
        return [];
    }
  }
}

export class EpsilonTTSPlugin implements VoicePlugin {
  constructor(private readonly socketFactory?: SocketFactory) {}

  private session: StreamingTtsSession | null = null;

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    const apiKey = requireStringConfig(config, "api_key");
    const baseUrl = readRequiredBaseUrl(config);
    const voice = readEpsilonVoice(config);
    const sampleRate = readEpsilonSampleRate(config);
    const audioFormat: AudioFormat = { encoding: "pcm_s16le", sampleRateHz: sampleRate, channels: 1 };
    assertAudioFormat(audioFormat);

    this.session = await startStreamingTtsSession(bus, {
      protocol: new EpsilonWireProtocol(voice),
      provider: { name: "epsilon", model: "epsilon-tts", region: "global" },
      format: audioFormat,
      sampleRateHz: sampleRate,
      url: () => buildEpsilonWsUrl(baseUrl, apiKey),
      retry: readProviderRetryConfig(config),
      finishTimeoutMs: readNonNegativeInteger(config["finish_timeout_ms"], 2000),
      metricPrefix: "tts.epsilon",
      replayMetrics: true,
      socketFactory: this.socketFactory ?? (await defaultNodeSocketFactory()),
      maxReconnectAttempts: 1,
      connectTimeoutMs: readPositiveInteger(config["connect_timeout_ms"], DEFAULT_CONNECT_TIMEOUT_MS),
      replayBufferSize: (config["replay_buffer_size"] as number) ?? 32,
      keepAliveIntervalMs: KEEP_ALIVE_INTERVAL_MS,
    });
  }

  async close(): Promise<void> {
    await this.session?.dispose();
    this.session = null;
  }
}

export function buildEpsilonWsUrl(baseUrl: string, apiKey: string): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  const path = trimmed.endsWith("/v1/audio/speech/ws") ? trimmed : `${trimmed}/v1/audio/speech/ws`;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}key=${encodeURIComponent(apiKey)}`;
}

export function readRequiredBaseUrl(config: PluginConfig): string {
  const baseUrl = optionalStringConfig(config, "base_url") ?? optionalStringConfig(config, "baseUrl");
  if (!baseUrl) {
    throw new Error("Plugin config missing required key: base_url (Epsilon TTS baseUrl)");
  }
  return baseUrl;
}

function readEpsilonVoice(config: PluginConfig): EpsilonVoice {
  const voice = optionalStringConfig(config, "voice") ?? "sinhala";
  if (!EPSILON_VOICES.includes(voice as EpsilonVoice)) {
    throw new Error(`Epsilon TTS voice must be one of: ${EPSILON_VOICES.join(", ")}`);
  }
  return voice as EpsilonVoice;
}

function readEpsilonSampleRate(config: PluginConfig): number {
  const sampleRate = config["sample_rate"];
  if (sampleRate === undefined) return EPSILON_SAMPLE_RATE_HZ;
  if (sampleRate !== EPSILON_SAMPLE_RATE_HZ) {
    throw new Error(`Epsilon TTS only supports sample_rate ${String(EPSILON_SAMPLE_RATE_HZ)}`);
  }
  return EPSILON_SAMPLE_RATE_HZ;
}

function epsilonProviderError(msg: Record<string, unknown>): Error {
  const message = typeof msg["message"] === "string" ? msg["message"] : "Epsilon TTS provider error";
  return new Error(message);
}

function readNonNegativeInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const integer = Math.floor(value);
  return integer >= 0 ? integer : fallback;
}

function readPositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const integer = Math.floor(value);
  return integer > 0 ? integer : fallback;
}
