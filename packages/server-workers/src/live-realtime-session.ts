// SPDX-License-Identifier: MIT
//
// Bi-model VoiceAgentSession for Cloudflare Workers: gpt-realtime front model
// dialed via createWorkersSocket, with a kuralle Vectorize-backed Reasoner back model.

import { VoiceAgentSession } from "@kuralle-syrinx/core";
import { RealtimeBridge, fromOpenAIRealtime } from "@kuralle-syrinx/realtime";
import type { RealtimeToolDef } from "@kuralle-syrinx/realtime";
import { createWorkersSocket } from "@kuralle-syrinx/ws/workers";
import type { VectorizeIndex } from "@cloudflare/workers-types";
import { createRealtimeKuralleReasoner } from "./kuralle-realtime-agent.js";

export interface RealtimeSessionEnv {
  readonly OPENAI_API_KEY?: string;
  readonly OPENAI_MODEL?: string;
  readonly VECTORIZE: VectorizeIndex;
}

export interface RealtimeSessionOptions {
  readonly sessionId?: string;
  readonly inputSampleRateHz?: number;
  readonly outputSampleRateHz?: number;
}

const ASK_UNIVERSITY_TOOL: RealtimeToolDef = {
  name: "ask_university",
  description: "Answer university student-relations questions (enrollment, add/drop, advising).",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

export function hasRealtimeSessionCredentials(env: RealtimeSessionEnv): boolean {
  return Boolean(env.OPENAI_API_KEY?.trim());
}

export async function createRealtimeVoiceAgentSession(
  env: RealtimeSessionEnv,
  options: RealtimeSessionOptions = {},
): Promise<VoiceAgentSession> {
  const openaiKey = requireKey(env.OPENAI_API_KEY, "OPENAI_API_KEY");
  const sessionId = options.sessionId?.trim() || crypto.randomUUID();

  const adapter = fromOpenAIRealtime({
    apiKey: openaiKey,
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
