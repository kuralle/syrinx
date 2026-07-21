// SPDX-License-Identifier: MIT
//
// ElevenLabs multi-context WebSocket TTS.
// Wire protocol pinned from:
//   https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-multi-stream-input
// Lifecycle (reconnect/keepalive/finish-timeout) lives in tts-core.

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
// A premade voice in the default set — accessible to free API accounts. (Library voices like
// Rachel 21m00Tcm4TlvDq8ikWAM require a paid plan: "cannot use library voices via the API".)
const DEFAULT_VOICE_ID = "EXAVITQu4vr4xnSDxMaL";
const DEFAULT_MODEL_ID = "eleven_flash_v2_5";
const DEFAULT_VOICE_SETTINGS: Record<string, unknown> = { stability: 0.5, similarity_boost: 0.75 };

interface ElevenLabsWireConfig {
  readonly modelId: string;
  readonly audioFormat: AudioFormat;
  readonly voiceSettings: Record<string, unknown>;
  readonly generationConfig?: Record<string, unknown>;
}

/** Exported for unit tests that exercise encode/decode without a live socket. */
export class ElevenLabsWireProtocol implements WireProtocol {
  private readonly charactersByKey = new Map<AttributionKey, number>();
  private readonly initializedKeys = new Set<AttributionKey>();
  private readonly billedKeys = new Set<AttributionKey>();

  constructor(private readonly cfg: ElevenLabsWireConfig) {}

  attributionFor(contextId: string): { key: AttributionKey; contextId: string } {
    return { key: attributionKey(contextId), contextId };
  }

  encodeText(key: AttributionKey, text: string): SocketData[] {
    this.charactersByKey.set(key, (this.charactersByKey.get(key) ?? 0) + text.length);
    const frames: SocketData[] = [];
    // Multi-stream requires initializing a context (voice_settings) before its first text —
    // without it ElevenLabs accepts the text but generates NO audio (a final with no audio frames).
    if (!this.initializedKeys.has(key)) {
      this.initializedKeys.add(key);
      const init: Record<string, unknown> = { text: " ", context_id: key, voice_settings: this.cfg.voiceSettings };
      if (this.cfg.generationConfig) init["generation_config"] = this.cfg.generationConfig;
      frames.push(JSON.stringify(init));
    }
    frames.push(JSON.stringify({ text, context_id: key }));
    return frames;
  }

  encodeFinish(contextId: string, _activeKeys: readonly AttributionKey[]): SocketData[] {
    return [JSON.stringify({ context_id: contextId, flush: true })];
  }

  encodeCancel(key: AttributionKey, _contextId: string): SocketData[] {
    this.charactersByKey.delete(key);
    this.initializedKeys.delete(key);
    this.billedKeys.delete(key);
    return [JSON.stringify({ context_id: key, close_context: true })];
  }

  encodeClose(): SocketData[] {
    return [JSON.stringify({ close_socket: true })];
  }

  decode(data: SocketData, _isBinary: boolean): readonly WireEvent[] {
    if (typeof data !== "string") return [];
    const msg = JSON.parse(data) as Record<string, unknown>;
    const contextId = readContextId(msg);
    const key = attributionKey(contextId || "");

    if (isErrorFrame(msg)) {
      return [{ type: "error", key: contextId ? key : null, error: elevenLabsProviderError(msg), endsContext: isFinalFlag(msg) }];
    }

    const events: WireEvent[] = [];
    const audioB64 = typeof msg["audio"] === "string" ? msg["audio"] : "";
    if (audioB64.length > 0) {
      if (!contextId) {
        events.push({ type: "error", key: null, error: new Error("ElevenLabs TTS audio frame missing context_id") });
      } else {
        try {
          const bytes = new Uint8Array(decodeStrictBase64(audioB64, "ElevenLabs TTS provider audio"));
          assertAudioPayload(this.cfg.audioFormat, bytes);
          events.push({ type: "audio", key, pcm: bytes });
          // Bill on real audio, once per context — NOT on isFinal. EL streams audio with
          // isFinal:null and may not send a separate isFinal:true final (the socket close is the
          // real end), and a rejected generation returns an empty final with no audio that must
          // NOT be billed. Audio-received is the correct "synthesis happened" signal.
          const characters = this.charactersByKey.get(key) ?? 0;
          if (!this.billedKeys.has(key) && characters > 0) {
            this.billedKeys.add(key);
            const modelId = this.cfg.modelId;
            events.push({
              type: "sideband",
              key,
              route: Route.Background,
              build: (ctxId, timestampMs) => ({
                kind: "usage.recorded",
                contextId: ctxId,
                timestampMs,
                stage: "tts" as const,
                provider: "elevenlabs",
                model: modelId,
                characters,
              }),
            });
          }
        } catch (err) {
          events.push({ type: "error", key, error: err instanceof Error ? err : new Error(String(err)) });
        }
      }
    }

    if (isFinalFlag(msg) && contextId) {
      events.push({ type: "context_end", key });
      this.charactersByKey.delete(key);
      this.billedKeys.delete(key);
      this.initializedKeys.delete(key);
    }
    return events;
  }
}

export class ElevenLabsTTSPlugin implements VoicePlugin {
  constructor(private readonly socketFactory?: SocketFactory) {}

  private session: StreamingTtsSession | null = null;

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    const apiKey = requireStringConfig(config, "api_key");
    const voiceId = optionalStringConfig(config, "voice_id") ?? DEFAULT_VOICE_ID;
    const modelId = optionalStringConfig(config, "model_id") ?? DEFAULT_MODEL_ID;
    const sampleRate = (config["sample_rate"] as number) ?? 16000;
    const voiceSettings = (config["voice_settings"] as Record<string, unknown> | undefined) ?? DEFAULT_VOICE_SETTINGS;
    const languageCode = optionalStringConfig(config, "language_code") ?? optionalStringConfig(config, "language");
    const baseUrl =
      optionalStringConfig(config, "endpoint_url") ??
      `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/multi-stream-input`;
    const audioFormat: AudioFormat = { encoding: "pcm_s16le", sampleRateHz: sampleRate, channels: 1 };
    assertAudioFormat(audioFormat);
    // Derive a sensible default from sample_rate, but let the dev override (mp3, ulaw_8000 for
    // telephony, etc.) — never hard-pin the provider's own format knob.
    const outputFormat = optionalStringConfig(config, "output_format") ?? pcmOutputFormat(sampleRate);
    // Optional provider-specific passthrough for the multi-stream context-init frame.
    const generationConfig = config["generation_config"] as Record<string, unknown> | undefined;

    this.session = await startStreamingTtsSession(bus, {
      protocol: new ElevenLabsWireProtocol({ modelId, audioFormat, voiceSettings, generationConfig }),
      provider: { name: "elevenlabs", model: modelId, region: "global" },
      format: audioFormat,
      sampleRateHz: sampleRate,
      url: () => {
        const params = new URLSearchParams({
          model_id: modelId,
          output_format: outputFormat,
        });
        if (languageCode) params.set("language_code", languageCode);
        const separator = baseUrl.includes("?") ? "&" : "?";
        return `${baseUrl}${separator}${params.toString()}`;
      },
      headers: { "xi-api-key": apiKey },
      retry: readProviderRetryConfig(config),
      finishTimeoutMs: readNonNegativeInteger(config["finish_timeout_ms"], 2000),
      metricPrefix: "tts.elevenlabs",
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

function pcmOutputFormat(sampleRate: number): string {
  switch (sampleRate) {
    case 8000:
      return "pcm_8000";
    case 16000:
      return "pcm_16000";
    case 22050:
      return "pcm_22050";
    case 24000:
      return "pcm_24000";
    case 44100:
      return "pcm_44100";
    default:
      return `pcm_${sampleRate}`;
  }
}

function readContextId(msg: Record<string, unknown>): string {
  if (typeof msg["context_id"] === "string") return msg["context_id"];
  if (typeof msg["contextId"] === "string") return msg["contextId"];
  return "";
}

function isFinalFlag(msg: Record<string, unknown>): boolean {
  return msg["is_final"] === true || msg["isFinal"] === true;
}

function isErrorFrame(msg: Record<string, unknown>): boolean {
  const type = typeof msg["type"] === "string" ? msg["type"].toLowerCase() : "";
  const messageType = typeof msg["message_type"] === "string" ? msg["message_type"].toLowerCase() : "";
  return type === "error" || messageType === "error" || typeof msg["error"] === "string";
}

function elevenLabsProviderError(msg: Record<string, unknown>): Error {
  const err =
    typeof msg["error"] === "string"
      ? msg["error"]
      : typeof msg["message"] === "string"
        ? msg["message"]
        : "ElevenLabs TTS provider error";
  return new Error(err);
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

function readNonNegativeInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const integer = Math.floor(value);
  return integer >= 0 ? integer : fallback;
}
