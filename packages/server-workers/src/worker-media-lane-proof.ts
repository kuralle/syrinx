// SPDX-License-Identifier: MIT
//
// Media-lane proof host — NOT a production worker. Deployed under throwaway names
// (syrinx-media-lane-proof-before / -after) to measure one thing: whether a slow
// Main-lane handler stalls outbound media on a real telephony wire.
//
// Why telephony and not the browser path: the server-side idle bed only exists for
// telephony wires (edge-twilio/edge-telnyx call idleFrame() on a 200ms timer). The
// browser path deliberately sends no idle bed between turns, so on a first-turn tool
// call there is no in-flight audio for the media lane to protect and the measurement
// has nothing to measure. That was established over six live browser-path runs.
//
// The ambient bed gives continuous, model-independent outbound media. The reasoner
// wrapper then blocks on a REAL subrequest inside the handler that drives the turn,
// which is what parks the drain loop. Before (no Route.Media) the bed should stall
// for the block's duration; after (Route.Media) it should keep its 200ms cadence.
//
// This file must compile UNCHANGED on both trees, so it deliberately does not touch
// any API that exists only at HEAD — notably it does not forward Reasoner.prewarm,
// which postdates the before-tree. Neither arm prewarms, which also makes them more
// comparable, not less.

import { Agent } from "agents";
import { withVoice } from "@kuralle-syrinx/cf-agents";
import type { Reasoner, ReasonerTurn, ReasoningPart } from "@kuralle-syrinx/core";
import {
  createLiveReasoner,
  liveCascadedPipeline,
  type LiveSessionEnv,
} from "./live-session.js";

export interface Env extends LiveSessionEnv {
  MEDIA_LANE_PROOF_CONVERSATIONS: DurableObjectNamespace;
  /** Absolute URL of this worker's own /delay route. Set per deployment in wrangler vars. */
  MEDIA_LANE_DELAY_URL?: string;
  /** Milliseconds the slow handler blocks. Default 2000. */
  MEDIA_LANE_DELAY_MS?: string;
}

const INPUT_SAMPLE_RATE_HZ = 16000;
const TWILIO_WIRE_SAMPLE_RATE_HZ = 8000;
const DEFAULT_DELAY_MS = 2000;

/**
 * A quiet, continuously looped bed. Synthesised rather than loaded from a fixture so
 * this file has no asset dependency and is byte-identical on both trees. Low amplitude
 * on purpose: it must be audible to the frame counter without dominating the call.
 */
function ambientBedPcm(): Int16Array {
  const samples = new Int16Array(TWILIO_WIRE_SAMPLE_RATE_HZ); // one second, loops
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.round(Math.sin((2 * Math.PI * 220 * index) / TWILIO_WIRE_SAMPLE_RATE_HZ) * 1200);
  }
  return samples;
}

/**
 * Wraps a reasoner so driving a turn first blocks on a real subrequest. That await
 * happens inside the handler the bus dispatches, so it parks the Main drain loop for
 * its whole duration — the same shape as a slow tool executing inside the reasoner.
 *
 * Only `stream` is implemented. See the file header for why no capability forwarding.
 */
class SlowHandlerReasoner implements Reasoner {
  constructor(
    private readonly inner: Reasoner,
    private readonly delayUrl: string | undefined,
    private readonly delayMs: number,
  ) {}

  async *stream(turn: ReasonerTurn): AsyncIterable<ReasoningPart> {
    if (this.delayUrl) {
      const url = `${this.delayUrl}?ms=${String(this.delayMs)}`;
      // Deliberately un-caught: a failed block would silently turn the proof into a
      // no-op run that looks healthy, which is the exact failure mode being guarded.
      await fetch(url, { method: "GET" });
    }
    yield* this.inner.stream(turn);
  }
}

/** Telephony host with a continuous idle bed and a deliberately slow Main-lane handler. */
export class MediaLaneProofConversation extends withVoice<Env, typeof Agent<Env>>(Agent<Env>, {
  transport: "twilio",
  pipeline: liveCascadedPipeline,
  reasoner: async (env, ctx) => {
    const inner = await createLiveReasoner(env, ctx);
    const delayMs = Number.parseInt(env.MEDIA_LANE_DELAY_MS ?? "", 10);
    return new SlowHandlerReasoner(
      inner,
      env.MEDIA_LANE_DELAY_URL,
      Number.isFinite(delayMs) && delayMs > 0 ? delayMs : DEFAULT_DELAY_MS,
    );
  },
  backgroundAudio: {
    ambient: { pcm: ambientBedPcm(), sampleRateHz: TWILIO_WIRE_SAMPLE_RATE_HZ, gain: 0.35 },
  },
  inputSampleRateHz: INPUT_SAMPLE_RATE_HZ,
  resumeWindowMs: 15_000,
}) {}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");

    // The slow tool's target. Held open server-side, so the caller experiences a real
    // socket wait rather than a local timer it could optimise away.
    if (url.pathname === "/delay") {
      const requested = Number.parseInt(url.searchParams.get("ms") ?? "", 10);
      const ms = Number.isFinite(requested) && requested >= 0 ? Math.min(requested, 30_000) : DEFAULT_DELAY_MS;
      await new Promise((resolve) => setTimeout(resolve, ms));
      return Response.json({ ok: true, delayMs: ms });
    }

    if (url.pathname === "/twilio") {
      const sessionId = url.searchParams.get("sessionId") ?? crypto.randomUUID();
      const id = env.MEDIA_LANE_PROOF_CONVERSATIONS.idFromName(sessionId);
      return await env.MEDIA_LANE_PROOF_CONVERSATIONS.get(id).fetch(request);
    }

    return new Response("not found", { status: 404 });
  },
};
