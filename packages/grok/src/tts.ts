// SPDX-License-Identifier: MIT
//
// Grok (xAI) TTS Plugin. The streaming lifecycle lives in @kuralle-syrinx/tts-core. This
// file is the Grok wire protocol: single-context streaming (one active utterance at a time),
// text.delta/text.done/text.clear out, base64 audio.delta in. Grok frames carry no key, so
// inbound audio is attributed to the one current context. Raw PCM may split mid-sample, so
// Grok relies on the engine's streaming carry.

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
import { base64ToBytes } from "@kuralle-syrinx/realtime";

const KEEP_ALIVE_INTERVAL_MS = 10_000;

class GrokWireProtocol implements WireProtocol {
  // Grok streams one context at a time; inbound frames carry no key, so they're attributed
  // to the current one. (Audio for an interrupted context is dropped by the engine's
  // cancelled-key tracking, which subsumes Grok's old `clearedPending` race guard.)
  private current: AttributionKey | null = null;

  attributionFor(contextId: string): { key: AttributionKey; contextId: string } {
    this.current = attributionKey(contextId);
    return { key: this.current, contextId };
  }

  encodeText(_key: AttributionKey, text: string): SocketData[] {
    return [JSON.stringify({ type: "text.delta", delta: text })];
  }

  encodeFinish(): SocketData[] {
    return [JSON.stringify({ type: "text.done" })];
  }

  encodeCancel(): SocketData[] {
    return [JSON.stringify({ type: "text.clear" })];
  }

  encodeClose(): SocketData[] {
    return [];
  }

  decode(data: SocketData): WireEvent[] {
    if (typeof data !== "string") return [];
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return []; // Grok ignores unparseable frames (does not fail the session).
    }
    const key = this.current;
    switch (msg["type"]) {
      case "audio.delta": {
        if (!key) return [];
        const delta = typeof msg["delta"] === "string" ? msg["delta"] : "";
        if (delta.length === 0) return [];
        try {
          return [{ type: "audio", key, pcm: base64ToBytes(delta) }];
        } catch (err) {
          return [{ type: "error", key, error: err instanceof Error ? err : new Error(String(err)) }];
        }
      }
      case "audio.done": {
        this.current = null;
        return key ? [{ type: "context_end", key }] : [];
      }
      case "audio.clear":
        // Provider acknowledged a text.clear. Audio for the interrupted context is already
        // dropped via the engine's cancelled tracking; nothing more to do.
        return [];
      case "error":
        return key ? [{ type: "error", key, error: grokProviderError(msg) }] : [];
      default:
        return [];
    }
  }
}

export class GrokTTSPlugin implements VoicePlugin {
  constructor(private readonly socketFactory?: SocketFactory) {}

  private session: StreamingTtsSession | null = null;

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    const apiKey = requireStringConfig(config, "api_key");
    const voiceId = optionalStringConfig(config, "voice_id") ?? "eve";
    const language = optionalStringConfig(config, "language") ?? "en";
    const endpointUrl = optionalStringConfig(config, "endpoint_url") ?? "wss://api.x.ai/v1/tts";
    const sampleRate = readPositiveInteger(config["sample_rate"], 16000);
    const audioFormat: AudioFormat = { encoding: "pcm_s16le", sampleRateHz: sampleRate, channels: 1 };
    assertAudioFormat(audioFormat);

    this.session = await startStreamingTtsSession(bus, {
      protocol: new GrokWireProtocol(),
      provider: { name: "grok", model: voiceId, region: "global" },
      format: audioFormat,
      sampleRateHz: sampleRate,
      url: () => {
        const params = new URLSearchParams({
          language,
          voice: voiceId,
          codec: "pcm",
          sample_rate: String(sampleRate),
        });
        const separator = endpointUrl.includes("?") ? "&" : "?";
        return `${endpointUrl}${separator}${params.toString()}`;
      },
      headers: { Authorization: `Bearer ${apiKey}` },
      retry: readProviderRetryConfig(config),
      finishTimeoutMs: readNonNegativeInteger(config["finish_timeout_ms"], 2000),
      metricPrefix: "tts.grok",
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

function grokProviderError(msg: Record<string, unknown>): Error {
  const message =
    (typeof msg["message"] === "string" && msg["message"]) ||
    (typeof msg["error"] === "string" && msg["error"]) ||
    "Grok TTS provider error";
  return new Error(message);
}

function readPositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const integer = Math.floor(value);
  return integer > 0 ? integer : fallback;
}

function readNonNegativeInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const integer = Math.floor(value);
  return integer >= 0 ? integer : fallback;
}
