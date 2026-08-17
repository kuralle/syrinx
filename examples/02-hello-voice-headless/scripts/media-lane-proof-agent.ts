// SPDX-License-Identifier: MIT
//
// Media-lane capstone proof — agent side. Load with dev-server's --agent flag:
//   SYRINX_PROOF_ARM=after npx tsx scripts/dev-server.ts \
//     --agent scripts/media-lane-proof-agent.ts#createSession
//
// WHY THE SLOW-TOOL FIXTURE COULD NEVER PROVE THIS
// -----------------------------------------------------------------------------
// Three live attempts on 2026-08-09 measured 25-85ms gaps in every arm, including
// a zero-delay control. Reading the code shows the premise was false, twice over:
//
//  1. The telephony idle bed is a raw `setInterval` in edge-twilio.ts that encodes
//     and writes STRAIGHT TO THE SOCKET. It never touches the PipelineBus, so a
//     parked drain loop cannot stall it — an awaiting handler leaves timers free.
//
//  2. A slow TOOL cannot park the drain loop either. The reasoner run that executes
//     tools is registered on `eos.turn_complete` with `{ concurrent: true }`
//     (aisdk/src/index.ts), and pipeline-bus.ts dispatches concurrent handlers
//     fire-and-forget (`void (async () => …)()`). Fire-and-forget is BY DEFINITION
//     not awaited, so no tool — however slow — defers any packet on any lane.
//
// The recorded artifacts agree: `largestGapMs` (tool window) is null on every run
// because the tool window contains zero audio frames, and the whole-utterance gap
// never moved. Nothing was ever parked, so the arms had nothing to differ about.
//
// WHAT THE MEDIA LANE ACTUALLY DEFENDS
// -----------------------------------------------------------------------------
// A NON-concurrent (consumer) handler on a Main-lane kind that awaits I/O. That one
// parks `drainRest` — and `drainMedia` keeps `tts.audio` flowing anyway, because
// `tts.audio` is in MEDIA_KINDS. That is the property, and it is the shape the
// decision document's spike actually modelled: "one Main handler on tts.text
// awaiting 2000ms of real I/O". This fixture builds exactly that.
//
// The block must land while the agent is ALREADY SPEAKING — a stall before the
// first frame yields no frames to gap. So it fires on the Nth `tts.text` chunk
// (default 3) of playout progress, by which point frames are already on the wire.
//
// ARMS (SYRINX_PROOF_ARM):
//   after   — shipped: tts.audio on Route.Media. Predict: no gap.
//   before  — media lane disabled: tts.audio demoted to Route.Main. Predict: ~delayMs.
//   control — before-arm routing, delay 0. Predict: no gap. If this one gaps, the
//             harness measures something other than parking and NEITHER other arm
//             means anything. This is the check the slow-tool attempts failed.

import { Route, type PipelineBus, type VoicePacket, type VoiceAgentSession } from "@kuralle-syrinx/core";
import { createUniversitySupportSession } from "../src/university-support-agent.js";

const INPUT_SAMPLE_RATE = 16_000;

type Arm = "after" | "before" | "control";

function resolveArm(): Arm {
  const raw = (process.env["SYRINX_PROOF_ARM"] ?? "after").trim().toLowerCase();
  if (raw === "after" || raw === "before" || raw === "control") return raw;
  throw new Error(`SYRINX_PROOF_ARM must be after|before|control, got: ${raw}`);
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Model the pre-media-lane world: demote Route.Media pushes to Route.Main so
 * `tts.audio` shares the single queue with application traffic, as it did before the
 * lane existed. Harness-only monkey-patch — no production code is touched, and the
 * "after" arm does not call this at all.
 */
function demoteMediaToMain(bus: PipelineBus): void {
  const original = bus.push.bind(bus);
  (bus as { push: PipelineBus["push"] }).push = ((route: Route, ...packets: VoicePacket[]) => {
    original(route === Route.Media ? Route.Main : route, ...packets);
  }) as PipelineBus["push"];
}

export function createSession(): VoiceAgentSession {
  const arm = resolveArm();
  const delayMs = arm === "control" ? 0 : envInt("SYRINX_PROOF_DELAY_MS", 2000);
  const blockOnChunk = envInt("SYRINX_PROOF_BLOCK_ON_CHUNK", 3);
  // Real socket I/O, not a timer — the delay server the harness already ships.
  // A timer would be a weaker claim: `setTimeout` is exactly what a reviewer would
  // suspect of not modelling real await-on-I/O behaviour.
  const delayUrl = process.env["SYRINX_MEDIA_LANE_DELAY_URL"]?.trim();

  const session = createUniversitySupportSession({
    inputSampleRate: INPUT_SAMPLE_RATE,
    profile: "interactive",
  });

  if (arm !== "after") demoteMediaToMain(session.bus);

  // Deliberately NOT `{ concurrent: true }`. A consumer handler that awaits is the one
  // thing that parks drainRest, and is therefore the only shape that can discriminate
  // the media lane.
  //
  // The trigger is `tts.playout_progress`, NOT `tts.text`. Measured: a turn emits only
  // TWO tts.text chunks, so a chunk-3 trigger never armed and the first live run applied
  // no treatment at all (before/after/control all read 28-77ms — a null result that
  // looked like a refutation). playout-progress.ts pushes tts.playout_progress on
  // Route.Main *as paced audio reaches the wire*, so it is both Main-lane and
  // guaranteed to fire mid-speech, which is exactly what this fixture needs.
  let seen = 0;
  let fired = false;
  session.bus.on("tts.playout_progress", async () => {
    seen += 1;
    if (fired || seen < blockOnChunk || delayMs <= 0) return;
    fired = true;
    const startedAt = Date.now();
    console.log(`PROOF_BLOCK_START arm=${arm} chunk=${seen} delayMs=${delayMs}`);
    try {
      if (delayUrl) {
        const url = new URL(delayUrl);
        url.searchParams.set("ms", String(delayMs));
        await fetch(url, { signal: AbortSignal.timeout(delayMs + 15_000) });
      } else {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    } catch (err) {
      console.log(`PROOF_BLOCK_ERROR arm=${arm} err=${String(err)}`);
    }
    console.log(`PROOF_BLOCK_END arm=${arm} heldMs=${Date.now() - startedAt}`);
  });

  console.log(
    `PROOF_AGENT arm=${arm} delayMs=${delayMs} blockOnChunk=${blockOnChunk} ` +
      `ttsAudioRoute=${arm === "after" ? "Media" : "Main(demoted)"} ` +
      `blockVia=${delayUrl ? "http" : "timer"}`,
  );
  return session;
}

export default createSession;
