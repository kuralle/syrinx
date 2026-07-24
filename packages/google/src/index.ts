// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Google Cloud Speech-to-Text Plugin
//
// Uses Google Cloud Speech-to-Text v2 REST API for streaming recognition.
// Wire protocol + lifecycle live in @kuralle-syrinx/stt-core; this file is
// the Google connect/config/decode surface only.
//
// Reference: Rapida transformer/google/stt.go (GCP Speech-to-Text v2 API)
// Reference: https://cloud.google.com/speech-to-text/v2/docs/streaming-recognize

import {
  Route,
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
  defaultNodeSocketFactory,
  startStreamingSttSession,
  type SttEvent,
  type SttWireProtocol,
  type StreamingSttSession,
} from "@kuralle-syrinx/stt-core";
import type { SocketData, SocketFactory } from "@kuralle-syrinx/ws";

type MetricSink = (name: string, value: string) => void;

class GoogleSttWireProtocol implements SttWireProtocol {
  constructor(
    private readonly configMsg: Record<string, unknown>,
    private readonly confidenceThreshold: number,
    private readonly onMetric: MetricSink,
  ) {}

  onOpen(): readonly SocketData[] {
    return [JSON.stringify(this.configMsg)];
  }

  encodeFinalize(_contextId: string): readonly SocketData[] {
    return [];
  }

  decode(data: SocketData, _isBinary: boolean): readonly SttEvent[] {
    if (typeof data !== "string") return [];
    let msg: { results?: unknown };
    try {
      msg = JSON.parse(data) as { results?: unknown };
    } catch {
      // Provider keepalives or malformed transient messages are ignored.
      return [];
    }

    const results = msg.results;
    if (!Array.isArray(results) || results.length === 0) return [];

    const events: SttEvent[] = [];
    for (const result of results) {
      const r = result as {
        alternatives?: Array<{ transcript?: unknown; confidence?: number }>;
        isFinal?: boolean;
        resultEndOffset?: unknown;
        resultEndTime?: unknown;
      };
      const alt = r.alternatives?.[0];
      if (!alt?.transcript) continue;

      const text = String(alt.transcript).trim();
      if (!text) continue;
      const confidence = alt.confidence ?? 0;

      if (this.confidenceThreshold > 0 && confidence < this.confidenceThreshold) {
        this.onMetric("stt_low_confidence", String(confidence));
        continue;
      }

      if (r.isFinal === true) {
        const audioSeconds = parseDurationSeconds(r.resultEndOffset ?? r.resultEndTime);
        events.push({
          type: "final",
          contextId: "",
          text,
          confidence,
          speechFinal: true,
          ...(audioSeconds !== null && audioSeconds > 0 ? { audioSeconds } : {}),
        });
      } else {
        events.push({ type: "interim", contextId: "", text });
      }
    }
    return events;
  }
}

export class GoogleSTTPlugin implements VoicePlugin {
  readonly endpointingCapability = {
    owner: "provider_stt" as const,
    disableConfig: {
      emit_eos_on_final: false,
    },
  };

  constructor(private readonly socketFactory?: SocketFactory) {}

  private session: StreamingSttSession | null = null;

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    const apiKey = requireStringConfig(config, "api_key");
    const projectId = requireStringConfig(config, "project_id");
    const languageCode = optionalStringConfig(config, "language") ?? "en-US";
    const languageCodes = readStringList(config["language_codes"]) ?? [languageCode];
    const model = optionalStringConfig(config, "model") ?? "latest_long";
    const endpointUrl = optionalStringConfig(config, "endpoint_url");
    const location = optionalStringConfig(config, "location") ?? "global";
    const recognizerId = optionalStringConfig(config, "recognizer") ?? "_";
    const sampleRate = (config["sample_rate"] as number) ?? 16000;
    const encoding = optionalStringConfig(config, "encoding") ?? "LINEAR16";
    const audioChannelCount =
      typeof config["channels"] === "number" && Number.isFinite(config["channels"])
        ? Math.max(1, Math.floor(config["channels"] as number))
        : 1;
    const enableAutomaticPunctuation = (config["enable_automatic_punctuation"] as boolean) ?? true;
    const enableWordConfidence = (config["enable_word_confidence"] as boolean) ?? true;
    const interimResults = (config["interim_results"] as boolean) ?? true;
    const recognitionFeatures = readPlainObject(config["recognition_features"]);
    const streamingFeatures = readPlainObject(config["streaming_features"]);
    const confidenceThreshold = (config["confidence_threshold"] as number) ?? 0;
    const emitEosOnFinal = (config["emit_eos_on_final"] as boolean) ?? true;

    const recognizerPath = `projects/${projectId}/locations/${location}/recognizers/${recognizerId}`;
    const audioFormat: AudioFormat = {
      encoding: "pcm_s16le",
      sampleRateHz: sampleRate,
      channels: 1,
    };
    assertAudioFormat(audioFormat);

    const configMsg = {
      recognizer: recognizerPath,
      streamingConfig: {
        config: {
          explicitDecodingConfig: {
            encoding,
            sampleRateHertz: sampleRate,
            audioChannelCount,
          },
          languageCodes,
          model,
          features: {
            enableAutomaticPunctuation,
            enableWordConfidence,
            ...recognitionFeatures,
          },
        },
        streamingFeatures: {
          interimResults,
          ...streamingFeatures,
        },
      },
    };

    this.session = await startStreamingSttSession(bus, {
      protocol: new GoogleSttWireProtocol(configMsg, confidenceThreshold, (name, value) => {
        bus.push(Route.Background, {
          kind: "metric.conversation",
          contextId: "",
          timestampMs: Date.now(),
          name,
          value,
        });
      }),
      provider: { name: "google", model, region: "global" },
      format: audioFormat,
      language: languageCode,
      emitEosOnFinal,
      url: () =>
        endpointUrl ??
        `wss://speech.googleapis.com/v2/${recognizerPath}:streamingRecognize?key=${apiKey}`,
      socketFactory: this.socketFactory ?? (await defaultNodeSocketFactory()),
      retry: readProviderRetryConfig(config),
      replayBufferSize: (config["replay_buffer_size"] as number) ?? 64,
      metricPrefix: "stt.google",
    });
  }

  async close(): Promise<void> {
    await this.session?.dispose();
    this.session = null;
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

function readPlainObject(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function readStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return list.length > 0 ? list : undefined;
}
