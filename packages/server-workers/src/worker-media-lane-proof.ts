// SPDX-License-Identifier: MIT
//
// Media-lane proof host for Workers/DO — NOT a production worker. Deployed under a
// throwaway name and deleted when the run finishes.
//
// WHY THIS FILE WAS REWRITTEN
// ---------------------------------------------------------------------------------
// The previous version measured the telephony idle bed and blocked inside a Reasoner
// wrapper. Both were falsified by reading the code, which is why every arm agreed:
//
//   - the idle bed is a raw `setInterval` in edge-twilio.ts that encodes a frame and
//     writes STRAIGHT TO THE SOCKET. It never touches the bus, so a parked drain loop
//     cannot stall it;
//   - a block inside `Reasoner.stream()` is consumed by the handler registered on
//     `eos.turn_complete` with `{ concurrent: true }`, which pipeline-bus dispatches
//     fire-and-forget. Fire-and-forget is by definition not awaited, so it parks
//     nothing.
//
// What the media lane actually defends is a NON-concurrent consumer handler on a
// Main-lane kind that awaits I/O: it parks `drainRest` while `drainMedia` keeps
// `tts.audio` flowing. This host builds exactly that, matching the Node WS proof so
// the two transports are compared on the same property.
//
// ONE DEPLOYMENT, THREE ARMS. The arm is the sessionId prefix, so all three arms run
// against identical code and identical config — no redeploy between arms, and no
// second git tree. Deploying the arms separately is what let the previous attempt
// compare two builds that differed in more than the lane.
//
//   after-<id>    shipped routing: tts.audio on Route.Media
//   before-<id>   lane disabled: Route.Media pushes demoted to Route.Main
//   control-<id>  before-arm routing, ZERO delay — the negative control
//
// The park must outlast the playout buffer or the buffer absorbs it and the run reads
// as a refutation. MEASURED on Node: a 2000ms park produced only 121-138ms of gap
// because ~2.3-2.5s of audio was already buffered; 10000ms produced 7666ms. Hence the
// 10s default here.

import { Agent } from "agents";
import { withVoice } from "@kuralle-syrinx/cf-agents";
import type { CascadedStage } from "@kuralle-syrinx/cf-agents";
import { Route, type PipelineBus, type PluginConfig, type VoicePacket, type VoicePlugin } from "@kuralle-syrinx/core";
import {
  createLiveReasoner,
  liveCascadedPipeline,
  type LiveSessionEnv,
} from "./live-session.js";

export interface Env extends LiveSessionEnv {
  MEDIA_LANE_PROOF_CONVERSATIONS: DurableObjectNamespace;
  /** Absolute URL of this worker's own /delay route. Set per deployment in wrangler vars. */
  MEDIA_LANE_DELAY_URL?: string;
  /** Milliseconds the parked handler blocks. Default 10000 — see the header. */
  MEDIA_LANE_DELAY_MS?: string;
  /** Nth tts.playout_progress that trips the park. Default 3. */
  MEDIA_LANE_BLOCK_ON?: string;
}

const INPUT_SAMPLE_RATE_HZ = 16000;
const DEFAULT_DELAY_MS = 10_000;
const DEFAULT_BLOCK_ON = 3;

type Arm = "after" | "before" | "control";

/** The arm is the sessionId prefix; anything unprefixed is the shipped configuration. */
export function armFromSessionId(sessionId: string): Arm {
  if (sessionId.startsWith("before-")) return "before";
  if (sessionId.startsWith("control-")) return "control";
  return "after";
}

/**
 * Model the pre-media-lane world by demoting Route.Media pushes to Route.Main, so
 * `tts.audio` shares the one queue with application traffic as it did before the lane
 * existed. Harness-only: no production code path is modified, and the "after" arm never
 * calls this.
 */
function demoteMediaToMain(bus: PipelineBus): void {
  const original = bus.push.bind(bus);
  (bus as { push: PipelineBus["push"] }).push = ((route: Route, ...packets: VoicePacket[]) => {
    original(route === Route.Media ? Route.Main : route, ...packets);
  }) as PipelineBus["push"];
}

/**
 * Wraps the TTS stage's plugin purely to reach the bus at `initialize`. The plugin
 * contract hands every plugin the session bus, and it is the only seam in the mixin
 * that does — `WithVoiceOptions` exposes no session or bus hook. Everything else is
 * delegated untouched, so TTS behaviour is identical across arms.
 */
class MediaLaneProofPlugin implements VoicePlugin {
  constructor(
    private readonly inner: VoicePlugin,
    private readonly arm: Arm,
    private readonly delayUrl: string | undefined,
    private readonly delayMs: number,
    private readonly blockOn: number,
  ) {}

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    if (this.arm !== "after") demoteMediaToMain(bus);

    // Deliberately NOT `{ concurrent: true }`. A consumer handler that awaits is the
    // one shape that parks drainRest, and therefore the only one that can discriminate
    // the media lane.
    //
    // The trigger is tts.playout_progress. On the EDGE transport the client is the
    // playout clock: edge.ts maps the browser's `playout_progress` message onto a
    // Route.Main tts.playout_progress packet. So it is Main-lane and arrives while
    // audio is playing — the same trigger the Node proof used, reached by the path the
    // edge actually uses. (tts.text is unusable: a turn emits only TWO chunks.)
    // Locates the stall. A sync, non-awaiting counter on tts.audio (legal on a media
    // kind) tells us whether TTS kept PRODUCING during the park. If audio was produced
    // but not delivered, the failure is in the lane/transport; if production stopped
    // too, the stall is upstream of the bus and the lane was never the deciding factor.
    let audioPushed = 0;
    bus.on("tts.audio", () => { audioPushed += 1; });

    let seen = 0;
    let fired = false;
    bus.on("tts.playout_progress", async () => {
      seen += 1;
      if (fired || seen < this.blockOn || this.delayMs <= 0) return;
      fired = true;
      const startedAt = Date.now();
      const audioAtStart = audioPushed;
      console.log(`PROOF_BLOCK_START arm=${this.arm} n=${seen} delayMs=${this.delayMs} ttsAudioSoFar=${audioAtStart}`);
      try {
        if (this.delayUrl) {
          await fetch(`${this.delayUrl}?ms=${String(this.delayMs)}`, { method: "GET" });
        } else {
          await new Promise((resolve) => setTimeout(resolve, this.delayMs));
        }
      } catch (err) {
        console.log(`PROOF_BLOCK_ERROR arm=${this.arm} err=${String(err)}`);
      }
      console.log(
        `PROOF_BLOCK_END arm=${this.arm} heldMs=${Date.now() - startedAt} ` +
          `ttsAudioDuringPark=${audioPushed - audioAtStart} ttsAudioTotal=${audioPushed}`,
      );
    });

    console.log(
      `PROOF_AGENT arm=${this.arm} delayMs=${this.delayMs} blockOn=${this.blockOn} ` +
        `ttsAudioRoute=${this.arm === "after" ? "Media" : "Main(demoted)"}`,
    );
    await this.inner.initialize(bus, config);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

function proofPipeline(env: Env): typeof liveCascadedPipeline {
  return {
    ...liveCascadedPipeline,
    tts: (pipelineEnv, ctx): CascadedStage => {
      const stage = liveCascadedPipeline.tts(pipelineEnv, ctx);
      const delayMs = Number.parseInt(env.MEDIA_LANE_DELAY_MS ?? "", 10);
      const blockOn = Number.parseInt(env.MEDIA_LANE_BLOCK_ON ?? "", 10);
      const arm = armFromSessionId(ctx.sessionId);
      return {
        ...stage,
        plugin: new MediaLaneProofPlugin(
          stage.plugin,
          arm,
          env.MEDIA_LANE_DELAY_URL,
          // The control arm is the before arm with the treatment removed.
          arm === "control" ? 0 : Number.isFinite(delayMs) && delayMs > 0 ? delayMs : DEFAULT_DELAY_MS,
          Number.isFinite(blockOn) && blockOn > 0 ? blockOn : DEFAULT_BLOCK_ON,
        ),
      };
    },
  };
}

export class MediaLaneProofConversation extends withVoice<Env, typeof Agent<Env>>(Agent<Env>, {
  transport: "edge",
  pipeline: {
    kind: "cascaded",
    stt: (env, ctx) => liveCascadedPipeline.stt(env, ctx),
    tts: (env, ctx) => proofPipeline(env as Env).tts(env, ctx),
    ...(liveCascadedPipeline.eos ? { eos: liveCascadedPipeline.eos } : {}),
    ...(liveCascadedPipeline.endpointingOwner !== undefined
      ? { endpointingOwner: liveCascadedPipeline.endpointingOwner }
      : {}),
  },
  reasoner: async (env, ctx) => await createLiveReasoner(env, ctx),
  inputSampleRateHz: INPUT_SAMPLE_RATE_HZ,
  // A playground/harness client is never nagged mid-measurement.
  idleTimeout: { durationMs: 0 },
}) {}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");

    // The park's target. Held open server-side so the handler waits on a real socket
    // rather than a local timer the runtime could collapse.
    if (url.pathname === "/delay") {
      const requested = Number.parseInt(url.searchParams.get("ms") ?? "", 10);
      const ms = Number.isFinite(requested) && requested >= 0 ? Math.min(requested, 30_000) : DEFAULT_DELAY_MS;
      await new Promise((resolve) => setTimeout(resolve, ms));
      return Response.json({ ok: true, delayMs: ms });
    }

    if (url.pathname === "/ws") {
      const sessionId = url.searchParams.get("sessionId") ?? crypto.randomUUID();
      const id = env.MEDIA_LANE_PROOF_CONVERSATIONS.idFromName(sessionId);
      return await env.MEDIA_LANE_PROOF_CONVERSATIONS.get(id).fetch(request);
    }

    return new Response("not found", { status: 404 });
  },
};
