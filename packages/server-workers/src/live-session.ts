// SPDX-License-Identifier: MIT
//
// Live VoiceAgentSession for the Cloudflare Workers Durable Object: real
// Deepgram STT + OpenAI (AI SDK bridge) + Cartesia TTS, all dialed over the
// Workers fetch-upgrade socket (createWorkersSocket) so no Node `ws` is pulled
// into the edge bundle. Turn-taking is owned by Deepgram endpointing
// (endpointingOwner: "provider_stt"), so no Silero VAD / Smart Turn ONNX is
// needed on the hot path.

import { VoiceAgentSession } from "@kuralle-syrinx/core";
import { ReasoningBridge, fromStreamText } from "@kuralle-syrinx/aisdk";
import { createOpenAI } from "@ai-sdk/openai";
import { stepCountIs } from "ai";
import { DeepgramSTTPlugin } from "@kuralle-syrinx/deepgram";
import { CartesiaTTSPlugin } from "@kuralle-syrinx/cartesia";
import { createWorkersSocket } from "@kuralle-syrinx/ws/workers";

/** Provider secrets + optional tuning, supplied as Workers env/secret bindings. */
export interface LiveSessionEnv {
  readonly DEEPGRAM_API_KEY?: string;
  readonly OPENAI_API_KEY?: string;
  readonly CARTESIA_API_KEY?: string;
  readonly CARTESIA_VOICE_ID?: string;
  readonly OPENAI_MODEL?: string;
  readonly SYRINX_SYSTEM_PROMPT?: string;
}

export interface LiveSessionOptions {
  readonly inputSampleRateHz?: number;
  readonly outputSampleRateHz?: number;
}

const DEFAULT_SYSTEM_PROMPT = [
  "You are a helpful voice assistant.",
  "Answer in one or two short, complete sentences, and always end with punctuation.",
].join(" ");
const DEFAULT_VOICE_ID = "694f9389-aac1-45b6-b726-9d9369183238";
const DEFAULT_MODEL = "gpt-4.1-mini";

/** True when every provider secret needed for a live turn is present. */
export function hasLiveSessionCredentials(env: LiveSessionEnv): boolean {
  return Boolean(env.DEEPGRAM_API_KEY && env.OPENAI_API_KEY && env.CARTESIA_API_KEY);
}

export function createLiveVoiceAgentSession(
  env: LiveSessionEnv,
  options: LiveSessionOptions = {},
): VoiceAgentSession {
  const deepgramKey = requireKey(env.DEEPGRAM_API_KEY, "DEEPGRAM_API_KEY");
  const openaiKey = requireKey(env.OPENAI_API_KEY, "OPENAI_API_KEY");
  const cartesiaKey = requireKey(env.CARTESIA_API_KEY, "CARTESIA_API_KEY");
  const inputSampleRateHz = options.inputSampleRateHz ?? 16000;
  const outputSampleRateHz = options.outputSampleRateHz ?? 16000;

  const session = new VoiceAgentSession({
    plugins: {
      stt: {
        api_key: deepgramKey,
        sample_rate: inputSampleRateHz,
        model: "nova-3",
        language: "en-US",
        endpointing: 300,
      },
      bridge: {},
      tts: {
        api_key: cartesiaKey,
        voice_id: env.CARTESIA_VOICE_ID ?? DEFAULT_VOICE_ID,
        model_id: "sonic-3",
        sample_rate: outputSampleRateHz,
        language: "en",
      },
    },
    sttForceFinalizeTimeoutMs: 3500,
    endpointingOwner: "provider_stt",
  });

  session.registerPlugin("stt", new DeepgramSTTPlugin(createWorkersSocket));
  session.registerPlugin("bridge", new ReasoningBridge(fromStreamText({
    model: createOpenAI({ apiKey: openaiKey })(env.OPENAI_MODEL ?? DEFAULT_MODEL),
    system: env.SYRINX_SYSTEM_PROMPT ?? DEFAULT_SYSTEM_PROMPT,
    temperature: 0.4,
    maxOutputTokens: 256,
    maxRetries: 0,
    timeout: 30_000,
    stopWhen: stepCountIs(1),
  })));
  session.registerPlugin("tts", new CartesiaTTSPlugin(createWorkersSocket));
  return session;
}

function requireKey(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is required to start a live voice session`);
  return trimmed;
}
