// SPDX-License-Identifier: MIT
//
// Bi-model voice pipeline for the Cloudflare Workers host: a gpt-realtime or Gemini
// Live front model with a kuralle Vectorize-backed Reasoner back model, consulted
// via the `ask_university` front-model delegate tool. This is the pipeline/brain
// layer — the host (worker-realtime.ts) composes it via `withVoice(Agent)`.

import type { Reasoner } from "@kuralle-syrinx/core";
import type { RealtimePipeline, VoicePipelineContext } from "@kuralle-syrinx/cf-agents";
import { fromGeminiLive, fromOpenAIRealtime } from "@kuralle-syrinx/realtime";
import type { RealtimeAdapter, RealtimeToolDef } from "@kuralle-syrinx/realtime";
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

function buildRealtimeFront(env: RealtimeSessionEnv): RealtimeAdapter {
  const front = resolveRealtimeFront(env);
  if (front === "gemini") {
    return fromGeminiLive({
      apiKey: requireKey(env.GEMINI_API_KEY, "GEMINI_API_KEY"),
      model: env.GEMINI_LIVE_MODEL?.trim() || DEFAULT_GEMINI_LIVE_MODEL,
      systemInstruction: REALTIME_SYSTEM_INSTRUCTION,
      tools: [ASK_UNIVERSITY_TOOL],
    });
  }
  return fromOpenAIRealtime({
    apiKey: requireKey(env.OPENAI_API_KEY, "OPENAI_API_KEY"),
    socketFactory: createWorkersSocket,
    turnDetection: { type: "server_vad", silence_duration_ms: 500 },
    inputTranscription: true,
    tools: [ASK_UNIVERSITY_TOOL],
  });
}

/** Realtime pipeline descriptor consumed by `withVoice(Agent)`. */
export const realtimeVoicePipeline: RealtimePipeline<RealtimeSessionEnv> = {
  kind: "realtime",
  front: (env) => buildRealtimeFront(env),
  delegateToolName: ASK_UNIVERSITY_TOOL.name,
};

/** The back model: a kuralle Vectorize-backed Reasoner, keyed by the session id. */
export function createRealtimeReasoner(
  env: RealtimeSessionEnv,
  ctx: VoicePipelineContext,
): Promise<Reasoner> {
  return createRealtimeKuralleReasoner(env, { sessionId: ctx.sessionId });
}

function requireKey(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is required to start a realtime voice session`);
  return trimmed;
}
