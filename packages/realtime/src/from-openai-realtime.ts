// SPDX-License-Identifier: MIT

import type { SocketFactory } from "@kuralle-syrinx/ws";

import { base64ToBytes, bytesToBase64 } from "./base64.js";
import { createOpenAiCompatibleRealtimeAdapter } from "./openai-compatible-realtime.js";
import type { RealtimeAdapter, RealtimeToolDef } from "./realtime-adapter.js";

const DEFAULT_MODEL = "gpt-realtime-2";
const DEFAULT_VOICE = "marin";
const DEFAULT_SAMPLE_RATE_HZ = 24_000;

export interface OpenAIRealtimeOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly voice?: string;
  readonly socketFactory: SocketFactory;
  readonly url?: () => string;
  /** Server turn-detection config. Defaults to semantic_vad; pass `server_vad` or `null` to override. */
  readonly turnDetection?: Record<string, unknown> | null;
  /**
   * Function tools the front model may call (e.g. a delegate tool routed to a Reasoner). Domain-neutral
   * — the caller supplies these. Empty by default (standalone s2s, no delegation).
   */
  readonly tools?: readonly RealtimeToolDef[];
  readonly debug?: boolean;
  /** gpt-realtime-2 requires response.create after function_call_output; set false for providers that do not. */
  readonly requiresResponseCreateAfterToolOutput?: boolean;
  readonly instructions?: string;
  readonly modalities?: readonly string[];
  readonly temperature?: number;
  readonly inputTranscription?: Record<string, unknown> | boolean;
  readonly toolChoice?: string | Record<string, unknown>;
  readonly inputRateHz?: number;
  readonly outputRateHz?: number;
}

export function fromOpenAIRealtime(opts: OpenAIRealtimeOptions): RealtimeAdapter {
  const inputRateHz = opts.inputRateHz ?? DEFAULT_SAMPLE_RATE_HZ;
  const outputRateHz = opts.outputRateHz ?? DEFAULT_SAMPLE_RATE_HZ;
  const model = opts.model ?? DEFAULT_MODEL;
  const voice = opts.voice ?? DEFAULT_VOICE;

  return createOpenAiCompatibleRealtimeAdapter({
    apiKey: opts.apiKey,
    socketFactory: opts.socketFactory,
    debug: opts.debug,
    defaultModel: DEFAULT_MODEL,
    model: opts.model,
    url: opts.url,
    caps: {
      inputSampleRateHz: inputRateHz,
      outputSampleRateHz: outputRateHz,
      supportsConcurrentToolAudio: true,
      supportsTruncate: true,
    },
    buildSessionUpdate: () => {
      const inputAudio: Record<string, unknown> = {
        format: { type: "audio/pcm", rate: inputRateHz },
        turn_detection:
          "turnDetection" in opts ? opts.turnDetection : { type: "semantic_vad" },
      };
      if (opts.inputTranscription !== undefined) {
        inputAudio["transcription"] =
          opts.inputTranscription === true ? { model: "whisper-1" } : opts.inputTranscription;
      }

      const session: Record<string, unknown> = {
        type: "realtime",
        model,
        output_modalities: opts.modalities ?? ["audio"],
        audio: {
          input: inputAudio,
          output: {
            format: { type: "audio/pcm", rate: outputRateHz },
            voice,
          },
        },
        tools: (opts.tools ?? []).map((t) => ({
          type: "function" as const,
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
        tool_choice: opts.toolChoice ?? "auto",
      };

      if (opts.instructions !== undefined) {
        session["instructions"] = opts.instructions;
      }
      if (opts.temperature !== undefined) {
        session["temperature"] = opts.temperature;
      }

      return session;
    },
    supportsTruncate: true,
    requiresResponseCreateAfterToolOutput: opts.requiresResponseCreateAfterToolOutput,
    defaultErrorMessage: "OpenAI Realtime error",
  });
}

export { bytesToBase64, base64ToBytes };
