// SPDX-License-Identifier: MIT

import type { SocketFactory } from "@kuralle-syrinx/ws";
import {
  base64ToBytes,
  bytesToBase64,
  createOpenAiCompatibleRealtimeAdapter,
  type RealtimeAdapter,
  type RealtimeToolDef,
} from "@kuralle-syrinx/realtime";

const DEFAULT_MODEL = "grok-voice-latest";
const DEFAULT_VOICE = "eve";
const DEFAULT_SAMPLE_RATE_HZ = 24_000;

export interface GrokRealtimeOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly voice?: string;
  readonly socketFactory: SocketFactory;
  readonly url?: () => string;
  readonly turnDetection?: Record<string, unknown> | null;
  readonly tools?: readonly RealtimeToolDef[];
  readonly debug?: boolean;
  readonly instructions?: string;
  readonly inputRateHz?: number;
  readonly outputRateHz?: number;
}

export function fromGrokRealtime(opts: GrokRealtimeOptions): RealtimeAdapter {
  const inputRateHz = opts.inputRateHz ?? DEFAULT_SAMPLE_RATE_HZ;
  const outputRateHz = opts.outputRateHz ?? DEFAULT_SAMPLE_RATE_HZ;
  const voice = opts.voice ?? DEFAULT_VOICE;

  return createOpenAiCompatibleRealtimeAdapter({
    apiKey: opts.apiKey,
    socketFactory: opts.socketFactory,
    debug: opts.debug,
    debugLogPrefix: "[grok-raw]",
    defaultModel: DEFAULT_MODEL,
    model: opts.model,
    url: opts.url,
    buildUrl: (model) => `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(model)}`,
    caps: {
      inputSampleRateHz: inputRateHz,
      outputSampleRateHz: outputRateHz,
      supportsConcurrentToolAudio: false,
      supportsTruncate: false,
      emitsServerSpeechStarted: false,
    },
    buildSessionUpdate: () => {
      const turnDetection =
        "turnDetection" in opts ? opts.turnDetection : { type: "server_vad" };

      const session: Record<string, unknown> = {
        voice,
        turn_detection: turnDetection,
        tools: (opts.tools ?? []).map((t) => ({
          type: "function" as const,
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
        audio: {
          input: { format: { type: "audio/pcm", rate: inputRateHz } },
          output: { format: { type: "audio/pcm", rate: outputRateHz }, voice },
        },
      };

      if (opts.instructions !== undefined) {
        session["instructions"] = opts.instructions;
      }

      return session;
    },
    supportsTruncate: false,
    defaultErrorMessage: "Grok Realtime error",
    extendServerMessage: (type, msg, ctx) => {
      if (type !== "conversation.item.input_audio_transcription.updated") return false;
      const transcript = typeof msg["transcript"] === "string" ? msg["transcript"] : "";
      if (transcript.length > 0) {
        ctx.push({
          type: "transcript",
          role: "user",
          text: transcript,
          final: true,
        });
      }
      return true;
    },
  });
}

export { base64ToBytes, bytesToBase64 };
