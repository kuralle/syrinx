// SPDX-License-Identifier: MIT
//
// Example: a Cloudflare `agents` SDK Agent given a Syrinx voice pipeline via
// `withVoice(Agent, …)` — one realtime agent and one cascaded agent, both
// served over the Syrinx edge voice protocol. Connect a Syrinx browser client to
// `wss://<worker>/agents/realtime-voice-agent/<id>` (or `/cascaded-voice-agent/…`).

import { Agent, routeAgentRequest } from "agents";
import { withVoice } from "@kuralle-syrinx/cf-agents";
import { fromGeminiLive } from "@kuralle-syrinx/realtime";
import { fromStreamText } from "@kuralle-syrinx/aisdk";
import { DeepgramSTTPlugin } from "@kuralle-syrinx/deepgram";
import { CartesiaTTSPlugin } from "@kuralle-syrinx/cartesia";
import { createWorkersSocket } from "@kuralle-syrinx/ws/workers";
import { createOpenAI } from "@ai-sdk/openai";

interface Env extends Record<string, unknown> {
  GEMINI_API_KEY: string;
  OPENAI_API_KEY: string;
  DEEPGRAM_API_KEY: string;
  CARTESIA_API_KEY: string;
  CARTESIA_VOICE_ID: string;
}

/**
 * Realtime front: a single speech-to-speech model (Gemini Live) owns STT, TTS,
 * and turn-taking. A kuralle agent would get its runtime as the brain by default;
 * this minimal example runs front-only.
 */
export class RealtimeVoiceAgent extends withVoice<Env, typeof Agent<Env>>(Agent<Env>, {
  pipeline: {
    kind: "realtime",
    front: (env) =>
      fromGeminiLive({
        apiKey: env.GEMINI_API_KEY,
        systemInstruction: "You are a concise, friendly voice assistant.",
      }),
  },
}) {}

/** Cascaded: Deepgram STT → LLM reasoner → Cartesia TTS. */
export class CascadedVoiceAgent extends withVoice<Env, typeof Agent<Env>>(Agent<Env>, {
  pipeline: {
    kind: "cascaded",
    stt: (env) => ({
      plugin: new DeepgramSTTPlugin(createWorkersSocket),
      config: { api_key: env.DEEPGRAM_API_KEY, model: "nova-3", sample_rate: 16000, language: "en-US" },
    }),
    tts: (env) => ({
      plugin: new CartesiaTTSPlugin(createWorkersSocket),
      config: {
        api_key: env.CARTESIA_API_KEY,
        voice_id: env.CARTESIA_VOICE_ID,
        model_id: "sonic-3",
        sample_rate: 16000,
      },
    }),
  },
  reasoner: (env) =>
    fromStreamText({
      model: createOpenAI({ apiKey: env.OPENAI_API_KEY })("gpt-4.1-mini"),
      system: "You are a concise, friendly voice assistant. Keep replies to 1-2 sentences.",
    }),
}) {}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 });
  },
};
