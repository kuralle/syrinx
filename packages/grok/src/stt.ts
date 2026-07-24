// SPDX-License-Identifier: MIT
//
// Grok (xAI) STT Plugin. The streaming lifecycle lives in @kuralle-syrinx/stt-core. This
// file is the Grok wire protocol: connect URL + query knobs, audio.done finalize, and
// decode of transcript.created / transcript.partial (is_final / duration / speech_final).

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

const AUDIO_DONE = JSON.stringify({ type: "audio.done" });

class GrokSttWireProtocol implements SttWireProtocol {
  private ready = false;

  isReady(): boolean {
    return this.ready;
  }

  onConnectionLost(): void {
    this.ready = false;
  }

  encodeFinalize(): SocketData[] {
    return [AUDIO_DONE];
  }

  encodeClose(): SocketData[] {
    return [AUDIO_DONE];
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
            `Grok STT provider sent malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
          ),
        },
      ];
    }

    const type = typeof msg["type"] === "string" ? msg["type"] : "";
    switch (type) {
      case "transcript.created":
        this.ready = true;
        return [];
      case "transcript.partial":
        return this.decodePartial(msg);
      case "transcript.done":
        return [];
      case "error":
        return [
          {
            type: "error",
            error: new Error(
              typeof msg["message"] === "string" ? msg["message"] : "Grok STT provider error",
            ),
          },
        ];
      default:
        return [];
    }
  }

  private decodePartial(msg: Record<string, unknown>): readonly SttEvent[] {
    const text = typeof msg["text"] === "string" ? msg["text"].trim() : "";
    if (!text) return [];

    const isFinal = msg["is_final"] === true;
    const speechFinal = msg["speech_final"] === true;
    const confidence =
      typeof msg["end_of_turn_confidence"] === "number" ? msg["end_of_turn_confidence"] : 0;
    // contextId is stamped by the session from the audio/turn context.
    const contextId = "";

    if (!isFinal) {
      return [{ type: "interim", contextId, text }];
    }

    return [
      {
        type: "final",
        contextId,
        text,
        confidence,
        speechFinal,
        audioSeconds: typeof msg["duration"] === "number" ? msg["duration"] : undefined,
        provider: {
          speechFinal,
          words: msg["words"],
          start: msg["start"],
          duration: msg["duration"],
        },
      },
    ];
  }
}

export class GrokSTTPlugin implements VoicePlugin {
  readonly endpointingCapability = {
    owner: "provider_stt" as const,
    disableConfig: {
      emit_eos_on_final: false,
      finalize_on_speech_final: false,
    },
  };

  constructor(private readonly socketFactory?: SocketFactory) {}

  private session: StreamingSttSession | null = null;

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    const apiKey = requireStringConfig(config, "api_key");
    const sampleRate = (config["sample_rate"] as number) ?? 16000;
    const language = optionalStringConfig(config, "language") ?? "en";
    const endpointUrl = optionalStringConfig(config, "endpoint_url") ?? "wss://api.x.ai/v1/stt";
    const encoding = optionalStringConfig(config, "encoding") ?? "pcm";
    const interimResults = (config["interim_results"] as boolean) ?? true;
    const endpointing = (config["endpointing"] as number) ?? 10;
    const smartTurn = typeof config["smart_turn"] === "number" ? config["smart_turn"] : undefined;
    const smartTurnTimeoutMs =
      typeof config["smart_turn_timeout"] === "number" ? config["smart_turn_timeout"] : undefined;
    const diarize = (config["diarize"] as boolean) ?? false;
    const keyterm = optionalStringConfig(config, "keyterm");
    const emitEosOnFinal = (config["emit_eos_on_final"] as boolean) ?? true;
    const queryParams = readPlainObject(config["query_params"]);
    const audioFormat: AudioFormat = { encoding: "pcm_s16le", sampleRateHz: sampleRate, channels: 1 };
    assertAudioFormat(audioFormat);

    this.session = await startStreamingSttSession(bus, {
      protocol: new GrokSttWireProtocol(),
      provider: { name: "grok", model: "stt", region: "global" },
      format: audioFormat,
      language,
      emitEosOnFinal,
      url: () => {
        const params = new URLSearchParams({
          sample_rate: String(sampleRate),
          encoding,
          interim_results: String(interimResults),
          language,
          endpointing: String(endpointing),
        });
        if (smartTurn !== undefined) params.set("smart_turn", String(smartTurn));
        if (smartTurnTimeoutMs !== undefined) {
          params.set("smart_turn_timeout", String(smartTurnTimeoutMs));
        }
        if (diarize) params.set("diarize", "true");
        if (keyterm) params.set("keyterm", keyterm);
        applyQueryParams(params, queryParams);
        const separator = endpointUrl.includes("?") ? "&" : "?";
        return `${endpointUrl}${separator}${params.toString()}`;
      },
      headers: { Authorization: `Bearer ${apiKey}` },
      socketFactory: this.socketFactory ?? (await defaultNodeSocketFactory()),
      retry: readProviderRetryConfig(config),
      replayBufferSize: (config["replay_buffer_size"] as number) ?? 64,
      metricPrefix: "stt.grok",
    });
  }

  async close(): Promise<void> {
    await this.session?.dispose();
    this.session = null;
  }
}

function readPlainObject(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function applyQueryParams(params: URLSearchParams, extra: Record<string, unknown> | undefined): void {
  if (!extra) return;
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) continue;
        params.append(key, String(item));
      }
      continue;
    }
    params.set(key, String(value));
  }
}
