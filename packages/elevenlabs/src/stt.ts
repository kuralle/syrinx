// SPDX-License-Identifier: MIT
//
// ElevenLabs Scribe v2 Realtime STT.
// Wire protocol pinned from:
//   https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
// Session lifecycle reuses @kuralle-syrinx/ws WebSocketConnection (reconnect/replay).

import type { PipelineBus } from "@kuralle-syrinx/core";
import {
  Route,
  type AudioFormat,
  type PluginConfig,
  type SttErrorPacket,
  type VoicePlugin,
  assertAudioFormat,
  assertAudioPayload,
  categorizeSttError,
  isRecoverable,
  optionalStringConfig,
  readProviderRetryConfig,
  requireStringConfig,
} from "@kuralle-syrinx/core";
import { WebSocketConnection, type SocketFactory } from "@kuralle-syrinx/ws";

const DEFAULT_MODEL_ID = "scribe_v2_realtime";
const DEFAULT_ENDPOINT = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";

export class ElevenLabsSTTPlugin implements VoicePlugin {
  readonly endpointingCapability = {
    owner: "provider_stt" as const,
    disableConfig: {
      emit_eos_on_final: false,
    },
  };

  constructor(private readonly socketFactory?: SocketFactory) {}

  private bus: PipelineBus | null = null;
  private conn: WebSocketConnection | null = null;
  private apiKey = "";
  private sampleRate = 16000;
  private model = DEFAULT_MODEL_ID;
  private language = "";
  private endpointUrl = DEFAULT_ENDPOINT;
  private commitStrategy: "manual" | "vad" = "manual";
  private emitEosOnFinal = true;
  private audioFormat: AudioFormat = { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 };
  private currentContextId = "";
  private sessionReady = false;
  private disposers: Array<() => void> = [];
  private audioStatsByContextId = new Map<
    string,
    { bytes: number; billedBytes: number }
  >();

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    this.apiKey = requireStringConfig(config, "api_key");
    this.sampleRate = (config["sample_rate"] as number) ?? 16000;
    this.model = optionalStringConfig(config, "model") ?? optionalStringConfig(config, "model_id") ?? DEFAULT_MODEL_ID;
    this.language = optionalStringConfig(config, "language") ?? optionalStringConfig(config, "language_code") ?? "";
    this.endpointUrl = optionalStringConfig(config, "endpoint_url") ?? DEFAULT_ENDPOINT;
    const strategy = optionalStringConfig(config, "commit_strategy");
    this.commitStrategy = strategy === "vad" ? "vad" : "manual";
    this.emitEosOnFinal = (config["emit_eos_on_final"] as boolean) ?? true;
    this.audioFormat = { encoding: "pcm_s16le", sampleRateHz: this.sampleRate, channels: 1 };
    assertAudioFormat(this.audioFormat);
    const audioFormatParam = pcmAudioFormatParam(this.sampleRate);

    this.conn = new WebSocketConnection({
      url: () => {
        const params = new URLSearchParams({
          model_id: this.model,
          audio_format: audioFormatParam,
          commit_strategy: this.commitStrategy,
        });
        if (this.language) params.set("language_code", this.language);
        const separator = this.endpointUrl.includes("?") ? "&" : "?";
        return `${this.endpointUrl}${separator}${params.toString()}`;
      },
      headers: { "xi-api-key": this.apiKey },
      socketFactory: this.socketFactory ?? (await defaultSocketFactory()),
      retry: readProviderRetryConfig(config),
      replayBufferSize: (config["replay_buffer_size"] as number) ?? 64,
      onMessage: (data) => {
        if (typeof data === "string") this.handleProviderMessage(data);
      },
      onConnectionLost: (err) => {
        this.sessionReady = false;
        this.emitError(this.currentContextId, err);
      },
    });
    await this.conn.connect();

    this.disposers.push(
      bus.on("stt.audio", (pkt: unknown) => {
        void this.handleAudioPacket(pkt as { audio: Uint8Array; contextId?: string });
      }),
      bus.on("user.audio_received", (pkt: unknown) => {
        void this.handleAudioPacket(pkt as { audio: Uint8Array; contextId?: string });
      }),
      bus.on("turn.change", (pkt: unknown) => {
        const next = (pkt as { contextId: string }).contextId;
        if (this.currentContextId && this.currentContextId !== next) {
          this.audioStatsByContextId.delete(this.currentContextId);
        }
        this.currentContextId = next;
      }),
      bus.on("interrupt.stt", () => {
        if (this.currentContextId) this.audioStatsByContextId.delete(this.currentContextId);
        this.currentContextId = "";
      }),
      bus.on("stt.finalize", (pkt: unknown) => {
        const request = pkt as { contextId?: string };
        void this.commit(request.contextId ?? this.currentContextId);
      }),
    );
  }

  private async handleAudioPacket(pkt: { audio: Uint8Array; contextId?: string }): Promise<void> {
    if (pkt.contextId) this.currentContextId = pkt.contextId;
    await this.sendAudio(pkt.audio, this.currentContextId, false);
  }

  async sendAudio(audio: Uint8Array, contextId = this.currentContextId, commit = false): Promise<boolean> {
    if (audio.byteLength === 0 && !commit) return true;
    try {
      if (audio.byteLength > 0) assertAudioPayload(this.audioFormat, audio);
      if (!this.conn) throw new Error("ElevenLabs STT is not connected");
      await this.conn.ensureReady();
      // Session is usable as soon as the socket is up; session_started is informative.
      // Audio before session_started is still accepted by the provider once connected.
      const frame = {
        message_type: "input_audio_chunk",
        audio_base_64: audio.byteLength > 0 ? Buffer.from(audio).toString("base64") : "",
        commit,
        sample_rate: this.sampleRate,
      };
      this.conn.send(JSON.stringify(frame));
      if (contextId && audio.byteLength > 0) this.recordAudioSent(contextId, audio.byteLength);
      return true;
    } catch (err) {
      this.emitError(contextId, err instanceof Error ? err : new Error(String(err)));
      return false;
    }
  }

  private async commit(contextId: string): Promise<void> {
    if (this.commitStrategy !== "manual") return;
    await this.sendAudio(new Uint8Array(0), contextId, true);
  }

  private handleProviderMessage(data: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data) as Record<string, unknown>;
    } catch (err) {
      this.emitError(
        this.currentContextId,
        new Error(`ElevenLabs STT provider sent malformed JSON: ${err instanceof Error ? err.message : String(err)}`),
      );
      return;
    }

    const messageType = typeof msg["message_type"] === "string" ? msg["message_type"] : "";
    switch (messageType) {
      case "session_started":
        this.sessionReady = true;
        return;
      case "partial_transcript":
        this.handlePartial(msg);
        return;
      case "committed_transcript":
      case "committed_transcript_with_timestamps":
      case "final_transcript":
      case "final_transcript_with_timestamps":
        this.handleCommitted(msg);
        return;
      case "error":
      case "auth_error":
      case "quota_exceeded":
      case "commit_throttled":
      case "unaccepted_terms":
      case "rate_limited":
      case "queue_overflow":
      case "resource_exhausted":
      case "session_time_limit_exceeded":
      case "input_error":
      case "chunk_size_exceeded":
      case "insufficient_audio_activity":
      case "transcriber_error":
        this.emitError(this.currentContextId, elevenLabsSttError(msg, messageType));
        return;
      default:
        return;
    }
  }

  private handlePartial(msg: Record<string, unknown>): void {
    const text = typeof msg["text"] === "string" ? msg["text"].trim() : "";
    if (!text) return;
    this.bus?.push(Route.Main, {
      kind: "stt.interim",
      contextId: this.currentContextId,
      timestampMs: Date.now(),
      text,
    });
  }

  private handleCommitted(msg: Record<string, unknown>): void {
    const text = typeof msg["text"] === "string" ? msg["text"].trim() : "";
    if (!text) return;
    const contextId = this.currentContextId;
    const language =
      typeof msg["language_code"] === "string" && msg["language_code"]
        ? msg["language_code"]
        : this.language || "en";
    this.bus?.push(Route.Main, {
      kind: "stt.result",
      contextId,
      timestampMs: Date.now(),
      text,
      confidence: 1,
      language,
      provider: {
        name: "elevenlabs",
        model: this.model,
        region: "global",
        words: msg["words"],
      },
    });
    this.emitSttUsage(contextId);
    if (this.emitEosOnFinal) {
      this.bus?.push(Route.Main, {
        kind: "eos.turn_complete",
        contextId,
        timestampMs: Date.now(),
        text,
        transcripts: [],
      });
    }
  }

  // Final-transcript funnel with incremental delta-billing (mirrors deepgram/grok).
  private emitSttUsage(contextId: string): void {
    const stats = this.audioStatsByContextId.get(contextId);
    if (!stats) return;
    const newBytes = stats.bytes - stats.billedBytes;
    if (newBytes <= 0) return;
    stats.billedBytes = stats.bytes;
    const audioSeconds = newBytes / 2 / this.sampleRate;
    this.bus?.push(Route.Background, {
      kind: "usage.recorded",
      contextId,
      timestampMs: Date.now(),
      stage: "stt",
      provider: "elevenlabs",
      model: this.model,
      audioSeconds,
    });
  }

  private recordAudioSent(contextId: string, byteLength: number): void {
    const current = this.audioStatsByContextId.get(contextId) ?? { bytes: 0, billedBytes: 0 };
    current.bytes += byteLength;
    this.audioStatsByContextId.set(contextId, current);
  }

  private emitError(contextId: string, err: Error): void {
    const category = categorizeSttError(err);
    const packet: SttErrorPacket = {
      kind: "stt.error",
      contextId,
      timestampMs: Date.now(),
      component: "stt",
      category,
      cause: err,
      isRecoverable: isRecoverable(category),
    };
    this.bus?.push(Route.Critical, packet);
  }

  async close(): Promise<void> {
    for (const dispose of this.disposers.splice(0)) dispose();
    await this.conn?.close();
    this.conn = null;
    this.bus = null;
    this.sessionReady = false;
    this.audioStatsByContextId.clear();
  }
}

function pcmAudioFormatParam(sampleRate: number): string {
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
    case 48000:
      return "pcm_48000";
    default:
      return `pcm_${sampleRate}`;
  }
}

function elevenLabsSttError(msg: Record<string, unknown>, messageType: string): Error {
  const detail = typeof msg["error"] === "string" ? msg["error"] : messageType;
  return new Error(`ElevenLabs STT provider error (${messageType}): ${detail}`);
}

async function defaultSocketFactory(): Promise<SocketFactory> {
  const mod = await import("@kuralle-syrinx/ws/node");
  return mod.createNodeWsSocket;
}
