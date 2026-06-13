// SPDX-License-Identifier: MIT
//
// Cloudflare Workers realtime (bi-model) voice host, built on `withVoice(Agent)`
// (issue #10 / W1). Same host machinery as the cascaded worker — the only
// difference is the pipeline (realtime front + kuralle back) and the reasoner.

import { Agent } from "agents";
import { withVoice } from "@kuralle-syrinx/cf-agents";
import {
  createRealtimeReasoner,
  realtimeVoicePipeline,
  type RealtimeSessionEnv,
} from "./live-realtime-session.js";

export interface Env extends RealtimeSessionEnv {
  readonly REALTIME_VOICE_CONVERSATIONS: DurableObjectNamespace;
}

const INPUT_SAMPLE_RATE_HZ = 16000;
const OUTPUT_SAMPLE_RATE_HZ = 16000;

export class RealtimeVoiceConversation extends withVoice<Env, typeof Agent<Env>>(Agent<Env>, {
  pipeline: realtimeVoicePipeline,
  reasoner: (env, ctx) => createRealtimeReasoner(env, ctx),
  inputSampleRateHz: INPUT_SAMPLE_RATE_HZ,
  outputSampleRateHz: OUTPUT_SAMPLE_RATE_HZ,
  resumeWindowMs: 15_000,
}) {}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname !== "/ws") return new Response("not found", { status: 404 });
    const sessionId = url.searchParams.get("sessionId") ?? crypto.randomUUID();
    const id = env.REALTIME_VOICE_CONVERSATIONS.idFromName(sessionId);
    return await env.REALTIME_VOICE_CONVERSATIONS.get(id).fetch(request);
  },
};
