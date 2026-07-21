// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Google Cloud Speech-to-Text Plugin
//
// Uses Google Cloud Speech-to-Text v2 REST API for streaming recognition.
// Sends audio chunks, receives interim and final transcripts.
// Pushes SttInterimPacket, SttResultPacket, and SttErrorPacket into the bus.
//
// Reference: Rapida transformer/google/stt.go (GCP Speech-to-Text v2 API)
// Reference: https://cloud.google.com/speech-to-text/v2/docs/streaming-recognize
//
// Unlike Deepgram which uses simple API keys, GCP requires:
//   - API key (for public API) OR
//   - Service account key (for private/project-scoped API)
//   - Project ID (required for recognizer path)

import type { PipelineBus } from "@kuralle-syrinx/core";
import {
  Route,
  type AudioFormat,
  type VoicePlugin,
  type PluginConfig,
  type SttErrorPacket,
  assertAudioFormat,
  assertAudioPayload,
  requireStringConfig,
  optionalStringConfig,
  categorizeSttError,
  isRecoverable,
  readProviderRetryConfig,
} from "@kuralle-syrinx/core";
import { WebSocketConnection, type SocketData, type SocketFactory } from "@kuralle-syrinx/ws";

// =============================================================================
// Types
// =============================================================================

interface GCPConfig {
  recognizer: string;
  encoding: string;
  sampleRateHertz: number;
  languageCodes: string[];
  model: string;
  enableAutomaticPunctuation: boolean;
  interimResults: boolean;
}

// =============================================================================
// Plugin
// =============================================================================

export class GoogleSTTPlugin implements VoicePlugin {
  readonly endpointingCapability = {
    owner: "provider_stt" as const,
    disableConfig: {
      emit_eos_on_final: false,
    },
  };

  constructor(private readonly socketFactory?: SocketFactory) {}

  private bus: PipelineBus | null = null;
  private conn: WebSocketConnection | null = null;
  private apiKey: string = "";
  private projectId: string = "";
  private languageCode: string = "en-US";
  private model: string = "latest_long";
  private endpointUrl: string | undefined;
  private currentContextId = "";
  private disposers: Array<() => void> = [];
  private recognizerPath = "";
  private sampleRate = 16000;
  private confidenceThreshold = 0;
  private emitEosOnFinal = true;
  private audioFormat: AudioFormat = { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 };
  /** Audio bytes + billed markers per context for usage.recorded audioSeconds. */
  private audioStatsByContextId = new Map<
    string,
    { bytes: number; billedBytes: number; billedOffsetSeconds: number }
  >();

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    this.apiKey = requireStringConfig(config, "api_key");
    this.projectId = requireStringConfig(config, "project_id");
    this.languageCode = optionalStringConfig(config, "language") ?? "en-US";
    this.model = optionalStringConfig(config, "model") ?? "latest_long";
    this.endpointUrl = optionalStringConfig(config, "endpoint_url");
    this.sampleRate = (config["sample_rate"] as number) ?? 16000;
    this.confidenceThreshold = (config["confidence_threshold"] as number) ?? 0;
    this.emitEosOnFinal = (config["emit_eos_on_final"] as boolean) ?? true;

    this.recognizerPath = `projects/${this.projectId}/locations/global/recognizers/_`;
    this.audioFormat = { encoding: "pcm_s16le", sampleRateHz: this.sampleRate, channels: 1 };
    assertAudioFormat(this.audioFormat);
    this.conn = new WebSocketConnection({
      url: () => {
        return this.endpointUrl ??
          `wss://speech.googleapis.com/v2/${this.recognizerPath}:streamingRecognize?key=${this.apiKey}`;
      },
      socketFactory: this.socketFactory ?? await defaultSocketFactory(),
      retry: readProviderRetryConfig(config),
      replayBufferSize: (config["replay_buffer_size"] as number) ?? 64,
      onReplay: (event, count) => {
        this.pushMetric(this.currentContextId, `stt.google.reconnect_replay_${event}`, String(count));
      },
      onReadyBeforeReplay: () => this.sendConfig(),
      onMessage: (data) => this.handleMessage(data),
      onConnectionLost: (err) => {
        this.emitError(err);
      },
      onUnrecoverable: (err) => {
        this.emitError(err);
      },
    });
    await this.conn.connect();

    this.disposers.push(
      bus.on("stt.audio", async (pkt: unknown) => {
        const audioPkt = pkt as { audio: Uint8Array; contextId?: string };
        this.currentContextId = audioPkt.contextId ?? this.currentContextId;
        await this.sendAudio(audioPkt.audio, this.currentContextId);
      }),
      bus.on("turn.change", (pkt: unknown) => {
        const next = (pkt as { contextId: string }).contextId;
        if (this.currentContextId && this.currentContextId !== next) {
          this.audioStatsByContextId.delete(this.currentContextId);
        }
        this.currentContextId = next;
      }),
    );
  }

  async sendAudio(audio: Uint8Array, contextId = this.currentContextId): Promise<void> {
    if (audio.byteLength === 0) return;
    try {
      assertAudioPayload(this.audioFormat, audio);
      if (!this.conn) throw new Error("Google STT is not connected");
      await this.conn.ensureReady();
      this.conn.send(audio);
      const stats = this.audioStats(contextId);
      stats.bytes += audio.byteLength;
    } catch (err) {
      this.emitError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  async close(): Promise<void> {
    for (const dispose of this.disposers.splice(0)) dispose();
    await this.conn?.close();
    this.conn = null;
    this.bus = null;
    this.audioStatsByContextId.clear();
  }

  private sendConfig(): void {
    const configMsg = {
      recognizer: this.recognizerPath,
      streamingConfig: {
        config: {
          explicitDecodingConfig: {
            encoding: "LINEAR16",
            sampleRateHertz: this.sampleRate,
            audioChannelCount: 1,
          },
          languageCodes: [this.languageCode],
          model: this.model,
          features: {
            enableAutomaticPunctuation: true,
            enableWordConfidence: true,
          },
        },
        streamingFeatures: {
          interimResults: true,
        },
      },
    };
    this.conn?.send(JSON.stringify(configMsg));
  }

  private handleMessage(data: SocketData): void {
    if (typeof data !== "string") return;
    try {
      const msg = JSON.parse(data);
      const results = msg.results;
      if (!Array.isArray(results) || results.length === 0) return;

      for (const result of results) {
        const alt = result.alternatives?.[0];
        if (!alt?.transcript) continue;

        const text = String(alt.transcript).trim();
        if (!text) continue;
        const confidence = alt.confidence ?? 0;

        if (this.confidenceThreshold > 0 && confidence < this.confidenceThreshold) {
          this.pushMetric(this.currentContextId, "stt_low_confidence", String(confidence));
          continue;
        }

        if (result.isFinal === true) {
          const contextId = this.currentContextId;
          this.bus?.push(Route.Main, {
            kind: "stt.result",
            contextId,
            timestampMs: Date.now(),
            text,
            confidence,
            language: this.languageCode,
            provider: { name: "google", model: this.model, region: "global" },
          });
          // Final-result funnel — fires under smart-turn endpointing too.
          this.emitSttUsage(contextId, result);
          if (this.emitEosOnFinal) {
            this.bus?.push(Route.Main, {
              kind: "eos.turn_complete",
              contextId,
              timestampMs: Date.now(),
              text,
              transcripts: [],
            });
          }
        } else {
          this.bus?.push(Route.Main, {
            kind: "stt.interim",
            contextId: this.currentContextId,
            timestampMs: Date.now(),
            text,
          });
        }
      }
    } catch {
      // Provider keepalives or malformed transient messages are ignored.
    }
  }

  private audioStats(contextId: string): {
    bytes: number;
    billedBytes: number;
    billedOffsetSeconds: number;
  } {
    let stats = this.audioStatsByContextId.get(contextId);
    if (!stats) {
      stats = { bytes: 0, billedBytes: 0, billedOffsetSeconds: 0 };
      this.audioStatsByContextId.set(contextId, stats);
    }
    return stats;
  }

  /**
   * Prefer provider result timing (`resultEndOffset` / `resultEndTime`) when present;
   * otherwise bill tracked PCM16 mono bytes as audio-seconds (bytes/2/sampleRate).
   * Multiple is_final segments each bill their delta so totals sum to the turn.
   */
  private emitSttUsage(contextId: string, result: Record<string, unknown>): void {
    const stats = this.audioStats(contextId);
    const offsetSeconds = parseDurationSeconds(result["resultEndOffset"] ?? result["resultEndTime"]);
    if (offsetSeconds !== null && offsetSeconds > 0) {
      const audioSeconds = offsetSeconds - stats.billedOffsetSeconds;
      if (audioSeconds <= 0) return;
      stats.billedOffsetSeconds = offsetSeconds;
      // Keep byte marker in sync so a later final without offset does not double-bill.
      stats.billedBytes = stats.bytes;
      this.bus?.push(Route.Background, {
        kind: "usage.recorded",
        contextId,
        timestampMs: Date.now(),
        stage: "stt",
        provider: "google",
        model: this.model,
        audioSeconds,
      });
      return;
    }

    const newBytes = stats.bytes - stats.billedBytes;
    if (newBytes <= 0) return;
    stats.billedBytes = stats.bytes;
    const audioSeconds = newBytes / 2 / this.sampleRate;
    this.bus?.push(Route.Background, {
      kind: "usage.recorded",
      contextId,
      timestampMs: Date.now(),
      stage: "stt",
      provider: "google",
      model: this.model,
      audioSeconds,
    });
  }

  private emitError(error: Error, category = categorizeSttError(error)): void {
    const packet: SttErrorPacket = {
      kind: "stt.error",
      contextId: this.currentContextId,
      timestampMs: Date.now(),
      component: "stt" as const,
      category,
      cause: error,
      isRecoverable: isRecoverable(category),
    };
    this.bus?.push(Route.Critical, packet);
  }

  private pushMetric(contextId: string, name: string, value: string): void {
    this.bus?.push(Route.Background, {
      kind: "metric.conversation",
      contextId,
      timestampMs: Date.now(),
      name,
      value,
    });
  }
}

/** Parse Google protobuf Duration JSON (`"1.250s"` or `{seconds,nanos}`) → seconds, or null. */
function parseDurationSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.endsWith("s")) {
      const n = Number(trimmed.slice(0, -1));
      return Number.isFinite(n) && n >= 0 ? n : null;
    }
    const n = Number(trimmed);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  if (value && typeof value === "object") {
    const obj = value as { seconds?: unknown; nanos?: unknown };
    const seconds =
      typeof obj.seconds === "number"
        ? obj.seconds
        : typeof obj.seconds === "string"
          ? Number(obj.seconds)
          : 0;
    const nanos =
      typeof obj.nanos === "number"
        ? obj.nanos
        : typeof obj.nanos === "string"
          ? Number(obj.nanos)
          : 0;
    if (!Number.isFinite(seconds) || !Number.isFinite(nanos)) return null;
    const total = seconds + nanos / 1e9;
    return total >= 0 ? total : null;
  }
  return null;
}

async function defaultSocketFactory(): Promise<SocketFactory> {
  const mod = await import("@kuralle-syrinx/ws/node");
  return mod.createNodeWsSocket;
}
