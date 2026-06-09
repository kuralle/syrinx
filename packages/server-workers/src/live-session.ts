// SPDX-License-Identifier: MIT
//
// Live VoiceAgentSession for the Cloudflare Workers Durable Object: real
// Deepgram STT + kuralle (Vectorize RAG) + Deepgram Aura TTS, all dialed over
// the Workers fetch-upgrade socket (createWorkersSocket) so no Node `ws` is pulled
// into the edge bundle. Turn-taking is owned by Deepgram endpointing
// (endpointingOwner: "provider_stt"), so no Silero VAD / Smart Turn ONNX is
// needed on the hot path.

import { VoiceAgentSession } from "@kuralle-syrinx/core";
import { ReasoningBridge } from "@kuralle-syrinx/aisdk";
import { DeepgramSTTPlugin, DeepgramTTSPlugin } from "@kuralle-syrinx/deepgram";
import { createWorkersSocket } from "@kuralle-syrinx/ws/workers";
import type { VectorizeIndex } from "@cloudflare/workers-types";
import { createRealtimeKuralleReasoner } from "./kuralle-realtime-agent.js";

/** Provider secrets + optional tuning, supplied as Workers env/secret bindings. */
export interface LiveSessionEnv {
  readonly DEEPGRAM_API_KEY?: string;
  readonly OPENAI_API_KEY?: string;
  readonly OPENAI_MODEL?: string;
  readonly VECTORIZE: VectorizeIndex;
}

export interface LiveSessionOptions {
  readonly sessionId?: string;
  readonly inputSampleRateHz?: number;
  readonly outputSampleRateHz?: number;
}

const DEFAULT_DEEPGRAM_TTS_MODEL = "aura-2-thalia-en";

/** True when every provider secret needed for a live turn is present. */
export function hasLiveSessionCredentials(env: LiveSessionEnv): boolean {
  return Boolean(env.DEEPGRAM_API_KEY?.trim() && env.OPENAI_API_KEY?.trim() && env.VECTORIZE);
}

export async function createLiveVoiceAgentSession(
  env: LiveSessionEnv,
  options: LiveSessionOptions = {},
): Promise<VoiceAgentSession> {
  const deepgramKey = requireKey(env.DEEPGRAM_API_KEY, "DEEPGRAM_API_KEY");
  requireKey(env.OPENAI_API_KEY, "OPENAI_API_KEY");
  if (!env.VECTORIZE) throw new Error("VECTORIZE binding is required to start a live voice session");
  const sessionId = options.sessionId?.trim() || crypto.randomUUID();
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
        provider_finalize_timeout_ms: 2500,
        finalize_timeout_fallback: true,
      },
      bridge: {},
      tts: {
        api_key: deepgramKey,
        model: DEFAULT_DEEPGRAM_TTS_MODEL,
        sample_rate: outputSampleRateHz,
      },
    },
    sttForceFinalizeTimeoutMs: 3500,
    endpointingOwner: "provider_stt",
  });

  const reasoner = await createRealtimeKuralleReasoner(env, { sessionId });
  session.registerPlugin("stt", new DeepgramSTTPlugin(createWorkersSocket));
  session.registerPlugin("bridge", new ReasoningBridge(reasoner));
  session.registerPlugin("tts", new DeepgramTTSPlugin(createWorkersSocket));
  return session;
}

function requireKey(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is required to start a live voice session`);
  return trimmed;
}
