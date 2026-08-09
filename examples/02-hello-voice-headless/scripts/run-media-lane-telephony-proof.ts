// SPDX-License-Identifier: MIT
//
// Media-lane capstone proof on the telephony wire.
//
// Measures ONE property: while a slow Main-lane handler blocks, does outbound media
// keep flowing? The browser path cannot answer this — it deliberately sends no idle
// bed between turns, so on a first-turn tool call there is no in-flight audio to
// protect and six live runs found zero frames in the tool window. Telephony can:
// edge-twilio calls BackgroundAudioMixer.idleFrame() on a 200ms timer, giving
// continuous outbound media independent of the model.
//
// So the discriminator is the bed's cadence. Healthy, inbound `media` events arrive
// about every 200ms. If the drain loop parks for the block's duration, the bed stops
// and a gap of that order appears. That is a far wider margin than the browser
// path's 20ms frames ever offered.
//
// Run against each arm:
//   SYRINX_MEDIA_LANE_PROOF_URL=https://syrinx-media-lane-proof-before.<sub>.workers.dev \
//     npx tsx scripts/run-media-lane-telephony-proof.ts --repeats 3

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { decodeMuLawToPcm16, encodePcm16ToMuLaw } from "@kuralle-syrinx/core/audio";

import { ensureRepoRootDotenv, readPcm16Mono16kWav } from "../src/run-one-turn.js";
import { computeLargestGapMs, formatMeasuredNumber, type Measured } from "./media-lane-gap-metrics.js";

const require = createRequire(import.meta.url);
const WebSocket = require("ws") as typeof import("ws").default;
type RawData = import("ws").RawData;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const FIXTURE_PATH = join(PKG_ROOT, "test", "fixtures", "university-support-add-drop.wav");
const RUNS_DIR = join(PKG_ROOT, "test", "performance", "runs");
const FRAME_SAMPLES_8K = 160; // 20ms at 8kHz
const IDLE_BED_CADENCE_MS = 200;
/** The bed ticks every 200ms, so allow a few missed ticks before calling it a stall. */
const GAP_THRESHOLD_MS = 800;
const OBSERVE_AFTER_SPEECH_MS = 25_000;

interface ArmRun {
  readonly runIndex: number;
  readonly mediaEvents: number;
  readonly arrivalTimestampsMs: number[];
  readonly largestGapMs: Measured<number>;
  readonly largestGapAtMs: number | null;
  readonly downlinkPeak: number;
  readonly bedSeen: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function downsampleTo8k(samples: Int16Array): Int16Array {
  const out = new Int16Array(Math.floor(samples.length / 2));
  for (let i = 0; i < out.length; i += 1) out[i] = samples[i * 2]!;
  return out;
}

function gapPosition(timestampsMs: readonly number[]): { gap: number; atMs: number } | null {
  if (timestampsMs.length < 2) return null;
  let gap = 0;
  let atMs = 0;
  for (let i = 1; i < timestampsMs.length; i += 1) {
    const delta = timestampsMs[i]! - timestampsMs[i - 1]!;
    if (delta > gap) {
      gap = delta;
      atMs = timestampsMs[i - 1]!;
    }
  }
  return { gap, atMs };
}

async function runOnce(baseUrl: string, runIndex: number): Promise<ArmRun> {
  const sessionId = `media-lane-proof-${randomUUID()}`;
  const wsUrl = `${baseUrl.replace(/^http/, "ws").replace(/\/$/, "")}/twilio?sessionId=${encodeURIComponent(sessionId)}`;
  const streamSid = `MZ${randomUUID().replaceAll("-", "")}`;
  const callSid = `CA${randomUUID().replaceAll("-", "")}`;

  const socket = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  const arrivalTimestampsMs: number[] = [];
  let downlinkPeak = 0;

  socket.on("message", (data: RawData) => {
    const text = data.toString();
    if (!text.startsWith("{")) return;
    const msg = JSON.parse(text) as Record<string, unknown>;
    if (msg.event !== "media") return;
    arrivalTimestampsMs.push(Date.now());
    const media = msg.media as { payload?: string } | undefined;
    if (media?.payload) {
      const pcm = decodeMuLawToPcm16(new Uint8Array(Buffer.from(media.payload, "base64")));
      for (const sample of pcm) downlinkPeak = Math.max(downlinkPeak, Math.abs(sample));
    }
  });

  socket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
  socket.send(JSON.stringify({
    event: "start",
    streamSid,
    start: { streamSid, callSid, mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 } },
  }));

  const sendFrame = (frame: Int16Array): void => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: Buffer.from(encodePcm16ToMuLaw(frame)).toString("base64") },
    }));
  };

  // Let the bed establish before speaking, so a stall is measured against a running
  // cadence rather than against startup.
  for (let i = 0; i < 50; i += 1) {
    sendFrame(new Int16Array(FRAME_SAMPLES_8K));
    await sleep(20);
  }

  const pcm8k = downsampleTo8k(readPcm16Mono16kWav(FIXTURE_PATH));
  for (let offset = 0; offset < pcm8k.length; offset += FRAME_SAMPLES_8K) {
    const frame = new Int16Array(FRAME_SAMPLES_8K);
    frame.set(pcm8k.subarray(offset, Math.min(offset + FRAME_SAMPLES_8K, pcm8k.length)));
    sendFrame(frame);
    await sleep(20);
  }

  // Hold the call open with silence across endpointing, the blocking handler, and the
  // answer. The bed should tick throughout; a stall shows as a gap in these arrivals.
  const deadline = Date.now() + OBSERVE_AFTER_SPEECH_MS;
  while (Date.now() < deadline) {
    sendFrame(new Int16Array(FRAME_SAMPLES_8K));
    await sleep(20);
  }

  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ event: "stop", streamSid }));
    await sleep(200);
  }
  socket.close();

  const position = gapPosition(arrivalTimestampsMs);
  return {
    runIndex,
    mediaEvents: arrivalTimestampsMs.length,
    arrivalTimestampsMs,
    largestGapMs: computeLargestGapMs(arrivalTimestampsMs),
    largestGapAtMs: position ? position.atMs - (arrivalTimestampsMs[0] ?? 0) : null,
    downlinkPeak,
    bedSeen: arrivalTimestampsMs.length > 10,
  };
}

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  const baseUrl = process.env["SYRINX_MEDIA_LANE_PROOF_URL"]?.trim();
  if (!baseUrl) throw new Error("SYRINX_MEDIA_LANE_PROOF_URL is required (the deployed proof worker)");
  if (!existsSync(FIXTURE_PATH)) throw new Error(`missing fixture ${FIXTURE_PATH}`);

  const repeatsArg = process.argv.indexOf("--repeats");
  const repeats = repeatsArg >= 0 ? Math.max(1, Number.parseInt(process.argv[repeatsArg + 1] ?? "1", 10)) : 1;

  const arm = baseUrl.includes("-before") ? "before" : baseUrl.includes("-after") ? "after" : "unknown";
  const runId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const runDir = join(RUNS_DIR, `media-lane-telephony-${arm}-${runId}`);
  await mkdir(runDir, { recursive: true });

  const runs: ArmRun[] = [];
  for (let index = 0; index < repeats; index += 1) {
    console.log(`[${arm}] run ${String(index + 1)}/${String(repeats)}`);
    const run = await runOnce(baseUrl, index);
    runs.push(run);
    console.log(
      `  mediaEvents=${String(run.mediaEvents)} bedSeen=${String(run.bedSeen)} ` +
        `downlinkPeak=${String(run.downlinkPeak)} ` +
        `largestGapMs=${formatMeasuredNumber(run.largestGapMs)} ` +
        `atMs=${run.largestGapAtMs === null ? "n/a" : String(run.largestGapAtMs)}`,
    );
    if (index + 1 < repeats) await sleep(1000);
  }

  const measured = runs.flatMap((r) => (r.largestGapMs.state === "measured" ? [r.largestGapMs.value] : []));
  const maxGap = measured.length > 0 ? Math.max(...measured) : null;
  const artifact = {
    scenario: "media_lane_telephony_proof",
    arm,
    baseUrl,
    generatedAt: new Date().toISOString(),
    idleBedCadenceMs: IDLE_BED_CADENCE_MS,
    gapThresholdMs: GAP_THRESHOLD_MS,
    repeats,
    runs,
    maxGapMs: maxGap,
  };
  const artifactPath = join(runDir, "artifact.json");
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  console.log("");
  console.log(`artifact: ${relative(PKG_ROOT, artifactPath)}`);
  if (maxGap === null) {
    console.log(`[${arm}] VERDICT: inconclusive — no run produced two media events`);
    return;
  }
  console.log(
    `[${arm}] max gap across ${String(measured.length)} run(s): ${String(maxGap)}ms ` +
      `(bed cadence ${String(IDLE_BED_CADENCE_MS)}ms, stall threshold ${String(GAP_THRESHOLD_MS)}ms) ` +
      `-> ${maxGap >= GAP_THRESHOLD_MS ? "STALL DETECTED" : "no stall"}`,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
