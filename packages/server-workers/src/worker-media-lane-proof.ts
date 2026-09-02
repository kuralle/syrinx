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
//
// DIAGNOSIS (2026-08-18): THE STALL IS BLOCKED PRODUCTION, NOT HELD EGRESS
// ---------------------------------------------------------------------------------
// An earlier note here claimed audio was "produced and dispatched but not flushed",
// inferring held egress from a COUNT of tts.audio dispatches during the park. That
// inference was wrong: a count cannot distinguish frames spread through the park from
// frames that stopped early.
//
// Timestamping the dispatches settles it. Across six runs the LAST dispatch offset was
// 342, 1775, 1994, 1848, 1821 and 3703ms into a 10000ms park, and zero dispatches
// landed in the final 500ms. Dispatch stops early in every run. If egress were being
// held, dispatch would continue for the whole park and only delivery would lag.
//
// So the inbound TTS provider socket stops delivering while the handler is parked, and
// resumes when it releases. The client-visible gap is therefore the REMAINDER of the
// park after production stopped — which is why the fault looked intermittent: a run
// only shows a gap when the utterance was still going when the park ended. A short
// utterance finishes inside the park and looks clean.
//
// The provider-free microbench corroborates this by NOT reproducing: 220 interleaved
// trials, zero stalls, across raw DO sockets, an agents-SDK Connection, both storage
// probes, and concurrent-vs-parked handlers. Its frames come from a LOCAL TIMER rather
// than an inbound socket event, and local timers are not deferred the way event
// delivery is. That difference is the whole finding.
//
// Consequence: the media lane cannot fix this. The lane routes audio that has already
// arrived; here the audio never arrives. See Cloudflare's input-gate rule — events are
// deferred until the object "is no longer executing JavaScript code".
//
// READ THIS BEFORE TRUSTING ANY SINGLE BATCH FROM THIS HOST
// ---------------------------------------------------------------------------------
// The Workers/DO stall this host measures is INTERMITTENT AND TEMPORALLY CLUSTERED.
// Across 25 runs of one identical configuration (arm=after, parkMode=main,
// durableHistory on) it stalled 11 times, and the stalls arrive in consecutive blocks:
// 2/3, then 5/5, then 0/3, then 4/8 (the first four, then clean), then 0/6. Same code,
// same config, same client, same session shape.
//
// The practical consequence: A SINGLE BATCH OF 3-6 RUNS CANNOT ESTABLISH OR REFUTE
// ANYTHING HERE. Two diagnosis experiments were run against this host and both are
// void for exactly that reason — the positive control failed to reproduce the stall,
// so their clean results carry no information. Any future attempt needs a reproducer
// that fires on demand, or interleaved A/B arms within one batch so both arms see the
// same platform conditions. Do not repeat the mistake of running arms sequentially in
// separate batches.

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
  /**
   * Diagnosis switch for the Workers/DO egress stall.
   *   "main"       (default) park in a NON-concurrent handler — parks drainRest.
   *   "concurrent" park in a `{ concurrent: true }` handler — dispatched
   *                fire-and-forget, so NO drain loop is parked. If audio still
   *                stalls here, drain-loop parking is not the cause and the await
   *                itself is gating egress.
   */
  MEDIA_LANE_PARK_MODE?: string;
  /**
   * Storage probe fired immediately BEFORE the park. Tests the documented
   * input-gate/output-gate interaction as the cause of the outbound stall.
   *   "none"        (default) no probe — the pre-existing, intermittent behaviour.
   *   "confirmed"   an un-awaited storage.put(). Output gates hold outgoing network
   *                 messages until that write CONFIRMS; input gates defer delivery of
   *                 non-storage events while the object is still executing JS. The park
   *                 keeps a JS task pending, so the prediction is that the write never
   *                 confirms and ALL outbound audio is held for the whole park.
   *   "unconfirmed" the same put() with { allowUnconfirmed: true }, the documented
   *                 output-gate bypass. Prediction: audio flows.
   */
  MEDIA_LANE_STORAGE_PROBE?: string;

}

const INPUT_SAMPLE_RATE_HZ = 16000;
const DEFAULT_DELAY_MS = 10_000;
const DEFAULT_BLOCK_ON = 3;
/**
 * Diagnosis switch — set false to remove DO SQLite writes from the session.
 *
 * NOT a confirmed variable. Turning it off produced three clean runs, but the positive
 * control (turning it back on) ALSO produced three clean runs, so that experiment
 * proves nothing. Kept because the next attempt will want it, not because it is
 * implicated. See the header note on reproducibility before drawing any conclusion.
 */
const DURABLE_HISTORY = true;

type Arm = "after" | "before" | "control";
type StorageProbe = "none" | "confirmed" | "unconfirmed";

/**
 * The live DO's storage handle. Module-level because the plugin needs it and the
 * VoicePlugin contract has no route to the DurableObjectState — one session per object,
 * so the last constructor to run is this session's.
 */
let currentStorage: DurableObjectStorage | undefined;

/** The arm is the sessionId prefix; anything unprefixed is the shipped configuration. */
export function armFromSessionId(sessionId: string): Arm {
  if (sessionId.startsWith("before-")) return "before";
  if (sessionId.startsWith("control-")) return "control";
  return "after";
}

/**
 * Park mode ALSO comes from the sessionId, so `main` and `concurrent` can be interleaved
 * inside one batch instead of run as consecutive blocks. Running them as separate batches
 * is what voided three earlier diagnosis attempts: against a fault whose incidence varies
 * with utterance length, a clean batch cannot be told from a working fix.
 * Env stays the default for any session that does not name a mode.
 */
export function parkModeFromSessionId(sessionId: string, fallback: "main" | "concurrent"): "main" | "concurrent" {
  if (sessionId.includes("-concurrent-")) return "concurrent";
  if (sessionId.includes("-main-")) return "main";
  return fallback;
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
    private readonly parkMode: "main" | "concurrent",
    private readonly storageProbe: StorageProbe,
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
    // Timestamps, not just a count. A COUNT cannot tell "frames spread evenly through
    // the park" (egress held) from "frames deferred, then delivered in a burst the
    // instant the park ended" (input gate deferring EVENT delivery). Those have
    // opposite causes, and the earlier localization rested on the count alone.
    let parkStartedAtMs = 0;
    const dispatchOffsetsMs: number[] = [];
    bus.on("tts.audio", () => {
      audioPushed += 1;
      if (parkStartedAtMs > 0) dispatchOffsetsMs.push(Date.now() - parkStartedAtMs);
    });

    let seen = 0;
    let fired = false;
    const park = async (): Promise<void> => {
      seen += 1;
      if (fired || seen < this.blockOn || this.delayMs <= 0) return;
      fired = true;
      const startedAt = Date.now();
      // Fire the storage probe BEFORE parking, so a write is outstanding for the
      // whole park. Deliberately NOT awaited — an awaited write would confirm before
      // the park begins and close nothing.
      if (this.storageProbe !== "none" && currentStorage) {
        const options = this.storageProbe === "unconfirmed" ? { allowUnconfirmed: true } : {};
        void currentStorage.put("media_lane_probe", seen, options);
      }
      const audioAtStart = audioPushed;
      parkStartedAtMs = Date.now();
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
      const held = Date.now() - startedAt;
      const lateWindowStart = held - 500;
      const inLast500 = dispatchOffsetsMs.filter((offset) => offset >= lateWindowStart).length;
      console.log(
        `PROOF_BLOCK_END arm=${this.arm} heldMs=${held} ` +
          `ttsAudioDuringPark=${audioPushed - audioAtStart} ttsAudioTotal=${audioPushed} ` +
          `firstOffset=${dispatchOffsetsMs[0] ?? -1} lastOffset=${dispatchOffsetsMs.at(-1) ?? -1} ` +
          `inLast500ms=${inLast500}`,
      );
    };
    bus.on("tts.playout_progress", park, this.parkMode === "concurrent" ? { concurrent: true } : { serial: true });

    console.log(
      `PROOF_AGENT arm=${this.arm} delayMs=${this.delayMs} blockOn=${this.blockOn} ` +
        `ttsAudioRoute=${this.arm === "after" ? "Media" : "Main(demoted)"} parkMode=${this.parkMode} ` +
        `storageProbe=${this.storageProbe}`,
    );
    await this.inner.initialize(bus, config);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

function resolveStorageProbe(raw: string | undefined): StorageProbe {
  const value = raw?.trim();
  return value === "confirmed" || value === "unconfirmed" ? value : "none";
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
          parkModeFromSessionId(
            ctx.sessionId,
            env.MEDIA_LANE_PARK_MODE?.trim() === "concurrent" ? "concurrent" : "main",
          ),
          resolveStorageProbe(env.MEDIA_LANE_STORAGE_PROBE),
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
  // Compile-time, not env: withVoice options are evaluated at module load, where the
  // Workers env is not yet available. Flipped by hand between diagnosis deploys.
  durableHistory: DURABLE_HISTORY,
}) {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    currentStorage = ctx.storage;
  }
}

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
