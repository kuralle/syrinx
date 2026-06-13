// SPDX-License-Identifier: MIT
//
// Cloudflare Workers cascaded voice host, built on `withVoice(Agent)` (issue #10 / W1).
// The Durable Object IS an `agents` SDK Agent: it provides hibernation, the
// `keepAlive()` lease, `Connection` lifecycle, and SQLite natively — so the prior
// manual alarm scheduler, durable session store, WebSocket lifecycle, and the 1012
// eviction-orphan workaround are gone. The brain is the `reasoner` param; the
// pipeline (Deepgram STT/TTS + kuralle) lives in live-session.ts.

import { Agent } from "agents";
import { withVoice } from "@kuralle-syrinx/cf-agents";
import { R2EdgeRecorder } from "@kuralle-syrinx/cf-agents/r2-recorder";
import {
  createLiveReasoner,
  liveCascadedPipeline,
  type LiveSessionEnv,
} from "./live-session.js";

export interface Env extends LiveSessionEnv {
  VOICE_CONVERSATIONS: DurableObjectNamespace;
  TWILIO_VOICE_CONVERSATIONS: DurableObjectNamespace;
  /** Optional: when bound, full call audio is recorded to this bucket. */
  RECORDINGS?: R2Bucket;
}

const INPUT_SAMPLE_RATE_HZ = 16000;
const OUTPUT_SAMPLE_RATE_HZ = 16000;

/** Browser/edge cascaded host (Syrinx JSON+envelope protocol over /ws). */
export class VoiceConversation extends withVoice<Env, typeof Agent<Env>>(Agent<Env>, {
  pipeline: liveCascadedPipeline,
  reasoner: (env, ctx) => createLiveReasoner(env, ctx),
  recorder: (env, { sessionId }) =>
    env.RECORDINGS
      ? new R2EdgeRecorder({ bucket: env.RECORDINGS, sessionId, startedAtMs: Date.now() })
      : undefined,
  inputSampleRateHz: INPUT_SAMPLE_RATE_HZ,
  outputSampleRateHz: OUTPUT_SAMPLE_RATE_HZ,
  resumeWindowMs: 15_000,
}) {}

/** Telephony cascaded host (Twilio Media Streams μ-law 8 kHz over /twilio). Same pipeline/brain. */
export class TwilioVoiceConversation extends withVoice<Env, typeof Agent<Env>>(Agent<Env>, {
  transport: "twilio",
  pipeline: liveCascadedPipeline,
  reasoner: (env, ctx) => createLiveReasoner(env, ctx),
  inputSampleRateHz: INPUT_SAMPLE_RATE_HZ,
  resumeWindowMs: 15_000,
}) {}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname === "/recordings") return await listRecordings(url, env);
    // Twilio Voice webhook: returns TwiML that bridges the inbound PSTN call to this
    // worker's own /twilio Media Streams endpoint over a bidirectional <Stream>. Point a
    // Twilio number's "A call comes in" webhook at https://<host>/incoming-call.
    if (url.pathname === "/incoming-call") return await twilioIncomingCallResponse(request, url);
    // Name-addressed routing: one DO per sessionId (callSid for telephony). The Agent
    // (partyserver) resolves its name from ctx.id.name, so a direct stub.fetch() upgrade
    // is valid for both transports.
    const sessionId = url.searchParams.get("sessionId") ?? crypto.randomUUID();
    if (url.pathname === "/twilio") {
      const id = env.TWILIO_VOICE_CONVERSATIONS.idFromName(sessionId);
      return await env.TWILIO_VOICE_CONVERSATIONS.get(id).fetch(request);
    }
    if (url.pathname !== "/ws") return new Response("not found", { status: 404 });
    const id = env.VOICE_CONVERSATIONS.idFromName(sessionId);
    return await env.VOICE_CONVERSATIONS.get(id).fetch(request);
  },
};

/**
 * Twilio Voice webhook → TwiML connecting the PSTN leg to /twilio over a bidirectional
 * <Stream>. The Twilio CallSid becomes the session id, so the call's media stream and any
 * resume/recording key off the same stable id.
 */
async function twilioIncomingCallResponse(request: Request, url: URL): Promise<Response> {
  let callSid = url.searchParams.get("CallSid") ?? "";
  if (!callSid && request.method === "POST") {
    const form = await request.formData().catch(() => null);
    const value = form?.get("CallSid");
    if (typeof value === "string") callSid = value;
  }
  const sessionId = callSid || crypto.randomUUID();
  const wsScheme = url.protocol === "https:" ? "wss" : "ws";
  const streamUrl = `${wsScheme}://${url.host}/twilio?sessionId=${encodeURIComponent(sessionId)}`;
  const twiml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    "  <Connect>",
    `    <Stream url="${xmlEscape(streamUrl)}" />`,
    "  </Connect>",
    "</Response>",
  ].join("\n");
  return new Response(twiml, { headers: { "content-type": "text/xml; charset=utf-8" } });
}

function xmlEscape(value: string): string {
  return value.replace(/[<>&"']/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c] ?? c,
  );
}

/** List recorded objects for a session: GET /recordings?sessionId=<id>. */
async function listRecordings(url: URL, env: Env): Promise<Response> {
  const sessionId = url.searchParams.get("sessionId");
  if (!env.RECORDINGS || !sessionId) return new Response("not found", { status: 404 });
  const listed = await env.RECORDINGS.list({ prefix: `recordings/${sessionId}/` });
  return Response.json(listed.objects.map((o) => ({ key: o.key, size: o.size })));
}
