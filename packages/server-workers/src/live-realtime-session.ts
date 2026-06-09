// SPDX-License-Identifier: MIT
//
// Bi-model VoiceAgentSession for Cloudflare Workers: gpt-realtime or Gemini Live front model,
// with a kuralle Vectorize-backed Reasoner back model.

import { VoiceAgentSession } from "@kuralle-syrinx/core";
import { RealtimeBridge, fromGeminiLive, fromOpenAIRealtime } from "@kuralle-syrinx/realtime";
import type { RealtimeToolDef } from "@kuralle-syrinx/realtime";
import { createWorkersSocket } from "@kuralle-syrinx/ws/workers";
import type { VectorizeIndex } from "@cloudflare/workers-types";
import { createRealtimeKuralleReasoner } from "./kuralle-realtime-agent.js";

export type RealtimeFront = "openai" | "gemini";

export interface RealtimeSessionEnv {
  readonly OPENAI_API_KEY?: string;
  readonly OPENAI_MODEL?: string;
  readonly GEMINI_API_KEY?: string;
  readonly GEMINI_LIVE_MODEL?: string;
  readonly REALTIME_FRONT?: string;
  readonly VECTORIZE: VectorizeIndex;
}

export interface RealtimeSessionOptions {
  readonly sessionId?: string;
  readonly inputSampleRateHz?: number;
  readonly outputSampleRateHz?: number;
}

const DEFAULT_GEMINI_LIVE_MODEL = "gemini-3.1-flash-live-preview";

const REALTIME_SYSTEM_INSTRUCTION =
  "You are a university student-relations voice assistant. Delegate factual questions to ask_university.";

const ASK_UNIVERSITY_TOOL: RealtimeToolDef = {
  name: "ask_university",
  description: "Answer university student-relations questions (enrollment, add/drop, advising).",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

export function resolveRealtimeFront(env: RealtimeSessionEnv): RealtimeFront {
  const front = env.REALTIME_FRONT?.trim().toLowerCase();
  return front === "gemini" ? "gemini" : "openai";
}

export function hasRealtimeSessionCredentials(env: RealtimeSessionEnv): boolean {
  const front = resolveRealtimeFront(env);
  if (front === "gemini") return Boolean(env.GEMINI_API_KEY?.trim());
  return Boolean(env.OPENAI_API_KEY?.trim());
}

export async function createRealtimeVoiceAgentSession(
  env: RealtimeSessionEnv,
  options: RealtimeSessionOptions = {},
): Promise<VoiceAgentSession> {
  const sessionId = options.sessionId?.trim() || crypto.randomUUID();
  const front = resolveRealtimeFront(env);

  const adapter = front === "gemini"
    ? fromGeminiLive({
        apiKey: requireKey(env.GEMINI_API_KEY, "GEMINI_API_KEY"),
        model: env.GEMINI_LIVE_MODEL?.trim() || DEFAULT_GEMINI_LIVE_MODEL,
        systemInstruction: REALTIME_SYSTEM_INSTRUCTION,
        tools: [ASK_UNIVERSITY_TOOL],
      })
    : fromOpenAIRealtime({
        apiKey: requireKey(env.OPENAI_API_KEY, "OPENAI_API_KEY"),
        socketFactory: createWorkersSocket,
        turnDetection: { type: "server_vad", silence_duration_ms: 500 },
        inputTranscription: true,
        tools: [ASK_UNIVERSITY_TOOL],
      });

  const universityReasoner = await createRealtimeKuralleReasoner(env, { sessionId });

  const bridge = new RealtimeBridge(adapter, universityReasoner, ASK_UNIVERSITY_TOOL.name);

  const session = new VoiceAgentSession({
    plugins: { realtime: {} },
    endpointingOwner: "timer",
  });
  session.registerPlugin("realtime", bridge);
  return session;
}

function requireKey(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is required to start a realtime voice session`);
  return trimmed;
}
