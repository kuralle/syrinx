// SPDX-License-Identifier: MIT
//
// ElevenLabs Scribe v2 Realtime STT.
// Wire protocol pinned from:
//   https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
// Session lifecycle lives in @kuralle-syrinx/stt-core.

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
  defaultNodeSocketFactory,
  startStreamingSttSession,
  type SttEvent,
  type SttWireProtocol,
  type StreamingSttSession,
} from "@kuralle-syrinx/stt-core";
import type { SocketData, SocketFactory } from "@kuralle-syrinx/ws";

const DEFAULT_MODEL_ID = "scribe_v2_realtime";
const DEFAULT_ENDPOINT = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";

class ElevenLabsSttWireProtocol implements SttWireProtocol {
  constructor(
    private readonly sampleRate: number,
    private readonly commitStrategy: "manual" | "vad",
    private readonly language: string,
  ) {}

  isReady(): boolean {
    // Session is usable as soon as the socket is up; session_started is informative.
    return true;
  }

  encodeAudio(audio: Uint8Array): readonly SocketData[] {
    return [
      JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: Buffer.from(audio).toString("base64"),
        commit: false,
        sample_rate: this.sampleRate,
      }),
    ];
  }

  encodeFinalize(_contextId: string): readonly SocketData[] {
    if (this.commitStrategy !== "manual") return [];
    return [
      JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: "",
        commit: true,
        sample_rate: this.sampleRate,
      }),
    ];
  }

  decode(data: SocketData, _isBinary: boolean): readonly SttEvent[] {
    if (typeof data !== "string") return [];
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data) as Record<string, unknown>;
    } catch (err) {
      return [
        {
          type: "error",
          error: new Error(
            `ElevenLabs STT provider sent malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
          ),
        },
      ];
    }

    const messageType = typeof msg["message_type"] === "string" ? msg["message_type"] : "";
    switch (messageType) {
      case "session_started":
        return [];
      case "partial_transcript": {
        const text = typeof msg["text"] === "string" ? msg["text"].trim() : "";
        if (!text) return [];
        return [{ type: "interim", contextId: "", text }];
      }
      case "committed_transcript":
      case "committed_transcript_with_timestamps":
      case "final_transcript":
      case "final_transcript_with_timestamps": {
        const text = typeof msg["text"] === "string" ? msg["text"].trim() : "";
        if (!text) return [];
        const language =
          typeof msg["language_code"] === "string" && msg["language_code"]
            ? msg["language_code"]
            : this.language || "en";
        return [
          {
            type: "final",
            contextId: "",
            text,
            confidence: 1,
            language,
            speechFinal: true,
            provider: { words: msg["words"] },
          },
        ];
      }
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
        return [{ type: "error", error: elevenLabsSttError(msg, messageType) }];
      default:
        return [];
    }
  }
}

export class ElevenLabsSTTPlugin implements VoicePlugin {
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
    const sampleRate = (config["sample_rate"] as number) ?? 16000;
    const model =
      optionalStringConfig(config, "model") ??
      optionalStringConfig(config, "model_id") ??
      DEFAULT_MODEL_ID;
    const language =
      optionalStringConfig(config, "language") ??
      optionalStringConfig(config, "language_code") ??
      "";
    const endpointUrl = optionalStringConfig(config, "endpoint_url") ?? DEFAULT_ENDPOINT;
    const strategy = optionalStringConfig(config, "commit_strategy");
    const commitStrategy: "manual" | "vad" = strategy === "vad" ? "vad" : "manual";
    const emitEosOnFinal = (config["emit_eos_on_final"] as boolean) ?? true;
    const audioFormat: AudioFormat = {
      encoding: "pcm_s16le",
      sampleRateHz: sampleRate,
      channels: 1,
    };
    assertAudioFormat(audioFormat);
    const audioFormatParam = pcmAudioFormatParam(sampleRate);

    this.session = await startStreamingSttSession(bus, {
      protocol: new ElevenLabsSttWireProtocol(sampleRate, commitStrategy, language),
      provider: { name: "elevenlabs", model, region: "global" },
      format: audioFormat,
      language: language || "en",
      emitEosOnFinal,
      url: () => {
        const params = new URLSearchParams({
          model_id: model,
          audio_format: audioFormatParam,
          commit_strategy: commitStrategy,
        });
        if (language) params.set("language_code", language);
        const separator = endpointUrl.includes("?") ? "&" : "?";
        return `${endpointUrl}${separator}${params.toString()}`;
      },
      headers: { "xi-api-key": apiKey },
      socketFactory: this.socketFactory ?? (await defaultNodeSocketFactory()),
      retry: readProviderRetryConfig(config),
      replayBufferSize: (config["replay_buffer_size"] as number) ?? 64,
      metricPrefix: "stt.elevenlabs",
    });
  }

  async close(): Promise<void> {
    await this.session?.dispose();
    this.session = null;
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
