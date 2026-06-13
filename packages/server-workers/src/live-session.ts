// SPDX-License-Identifier: MIT
//
// Cascaded voice pipeline for the Cloudflare Workers host: real Deepgram STT
// (nova-3, provider-endpointed) + kuralle (Vectorize RAG) Reasoner + Deepgram
// Aura TTS, all dialed over the Workers fetch-upgrade socket (createWorkersSocket)
// so no Node `ws` is pulled into the edge bundle. Turn-taking is owned by Deepgram
// endpointing (endpointingOwner: "provider_stt"), so no Silero VAD / Smart Turn
// ONNX is needed on the hot path.
//
// This is the pipeline/brain layer — the host (worker.ts) composes it via
// `withVoice(Agent)`; this module owns the plugin slots and the reasoner, not the
// connection lifecycle.

import type { Reasoner } from "@kuralle-syrinx/core";
import type { CascadedPipeline, VoicePipelineContext } from "@kuralle-syrinx/cf-agents";
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

const DEFAULT_DEEPGRAM_TTS_MODEL = "aura-2-thalia-en";
const INPUT_SAMPLE_RATE_HZ = 16000;
const OUTPUT_SAMPLE_RATE_HZ = 16000;

/** True when every provider secret needed for a live turn is present. */
export function hasLiveSessionCredentials(env: LiveSessionEnv): boolean {
  return Boolean(env.DEEPGRAM_API_KEY?.trim() && env.OPENAI_API_KEY?.trim() && env.VECTORIZE);
}

/**
 * Cascaded pipeline descriptor consumed by `withVoice(Agent)`. Deepgram Nova-3 STT
 * (provider-endpointed, VAD events for barge-in) → kuralle Reasoner → Deepgram Aura
 * TTS. `sttForceFinalizeTimeoutMs: 3500` keeps the engine's force-finalize tighter
 * than the 7000ms default for the provider-endpointed cascade.
 */
export const liveCascadedPipeline: CascadedPipeline<LiveSessionEnv> = {
  kind: "cascaded",
  stt: (env) => ({
    plugin: new DeepgramSTTPlugin(createWorkersSocket),
    config: {
      api_key: requireKey(env.DEEPGRAM_API_KEY, "DEEPGRAM_API_KEY"),
      sample_rate: INPUT_SAMPLE_RATE_HZ,
      model: "nova-3",
      language: "en-US",
      endpointing: 300,
      provider_finalize_timeout_ms: 2500,
      finalize_timeout_fallback: true,
      // No local VAD on the edge: Deepgram SpeechStarted is the barge-in
      // speech-start signal (vad.speech_started producer).
      vad_events: true,
    },
  }),
  tts: (env) => ({
    plugin: new DeepgramTTSPlugin(createWorkersSocket),
    config: {
      api_key: requireKey(env.DEEPGRAM_API_KEY, "DEEPGRAM_API_KEY"),
      model: DEFAULT_DEEPGRAM_TTS_MODEL,
      sample_rate: OUTPUT_SAMPLE_RATE_HZ,
    },
  }),
  endpointingOwner: "provider_stt",
  sttForceFinalizeTimeoutMs: 3500,
};

/** The brain: a kuralle Vectorize-backed Reasoner, keyed by the session id. */
export async function createLiveReasoner(env: LiveSessionEnv, ctx: VoicePipelineContext): Promise<Reasoner> {
  requireKey(env.OPENAI_API_KEY, "OPENAI_API_KEY");
  if (!env.VECTORIZE) throw new Error("VECTORIZE binding is required to start a live voice session");
  return createRealtimeKuralleReasoner(env, { sessionId: ctx.sessionId });
}

function requireKey(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is required to start a live voice session`);
  return trimmed;
}
