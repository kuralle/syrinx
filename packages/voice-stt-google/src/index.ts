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

import type { PipelineBus } from "@asyncdot/voice";
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
} from "@asyncdot/voice";
import { WebSocketConnection, type SocketData, type SocketFactory } from "@asyncdot/voice-ws";

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
        await this.sendAudio(audioPkt.audio);
      }),
      bus.on("turn.change", (pkt: unknown) => {
        this.currentContextId = (pkt as { contextId: string }).contextId;
      }),
    );
  }

  async sendAudio(audio: Uint8Array): Promise<void> {
    if (audio.byteLength === 0) return;
    try {
      assertAudioPayload(this.audioFormat, audio);
      if (!this.conn) throw new Error("Google STT is not connected");
      await this.conn.ensureReady();
      this.conn.send(audio);
    } catch (err) {
      this.emitError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  async close(): Promise<void> {
    for (const dispose of this.disposers.splice(0)) dispose();
    await this.conn?.close();
    this.conn = null;
    this.bus = null;
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
          this.bus?.push(Route.Main, {
            kind: "stt.result",
            contextId: this.currentContextId,
            timestampMs: Date.now(),
            text,
            confidence,
            language: this.languageCode,
            provider: { name: "google", model: this.model, region: "global" },
          });
          if (this.emitEosOnFinal) {
            this.bus?.push(Route.Main, {
              kind: "eos.turn_complete",
              contextId: this.currentContextId,
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

async function defaultSocketFactory(): Promise<SocketFactory> {
  const mod = await import("@asyncdot/voice-ws/node");
  return mod.createNodeWsSocket;
}
