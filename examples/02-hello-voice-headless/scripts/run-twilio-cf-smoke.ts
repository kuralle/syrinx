// SPDX-License-Identifier: MIT
//
// Live CF Twilio ingress gate: speak the Twilio Media Streams protocol at the
// deployed /twilio endpoint — connected/start, stream the question as base64
// μ-law 8 kHz media events at real-time pacing, then assert (1) non-silent μ-law
// media frames come back (the agent's answer on the phone leg) and (2) talking
// over the answer produces a Twilio `clear` event (barge-in on the phone leg).

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  decodeMuLawToPcm16,
  encodePcm16ToMuLaw,
} from "@kuralle-syrinx/core/audio";

import { ensureRepoRootDotenv, readPcm16Mono16kWav } from "../src/run-one-turn.js";

const require = createRequire(import.meta.url);
const WebSocket = require("ws") as typeof import("ws").default;
type RawData = import("ws").RawData;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const FIXTURE_PATH = join(PKG_ROOT, "test", "fixtures", "university-cs-masters-deadline.wav");
const OUTPUT_DIR = join(PKG_ROOT, "test", "performance", "runs", "twilio-cf-smoke");
const FRAME_SAMPLES_8K = 160; // 20ms at 8kHz

interface TwilioSmokeResult {
  readonly ok: boolean;
  readonly wsUrl: string;
  readonly mediaFramesReceived: number;
  readonly downlinkPeak: number;
  readonly firstMediaAtMs: number | null;
  readonly clearReceived: boolean;
  readonly clearAtMs: number | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Crude 16k→8k for the uplink fixture (decimation is fine for a smoke). */
function downsampleTo8k(samples: Int16Array): Int16Array {
  const out = new Int16Array(Math.floor(samples.length / 2));
  for (let i = 0; i < out.length; i += 1) out[i] = samples[i * 2]!;
  return out;
}

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  const deployedUrl = process.env["SYRINX_CF_CASCADE_URL"]?.trim();
  if (!deployedUrl) throw new Error("SYRINX_CF_CASCADE_URL is required");
  if (!existsSync(FIXTURE_PATH)) {
    throw new Error(`missing fixture ${FIXTURE_PATH} — run run-cascade-cf-smoke.ts once to synthesize it`);
  }
  await mkdir(OUTPUT_DIR, { recursive: true });

  const sessionId = `cf-twilio-${randomUUID()}`;
  const wsUrl = deployedUrl.replace(/^http/, "ws").replace(/\/$/, "") +
    `/twilio?sessionId=${encodeURIComponent(sessionId)}`;
  const streamSid = `MZ${randomUUID().replaceAll("-", "")}`;
  const callSid = `CA${randomUUID().replaceAll("-", "")}`;

  const socket = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  const startedAt = Date.now();
  let mediaFramesReceived = 0;
  let downlinkPeak = 0;
  let firstMediaAtMs: number | null = null;
  let clearReceived = false;
  let clearAtMs: number | null = null;

  socket.on("message", (data: RawData) => {
    const text = data.toString();
    if (!text.startsWith("{")) return;
    const msg = JSON.parse(text) as Record<string, unknown>;
    if (msg.event === "media") {
      mediaFramesReceived += 1;
      if (firstMediaAtMs === null) firstMediaAtMs = Date.now() - startedAt;
      const media = msg.media as { payload?: string } | undefined;
      if (media?.payload) {
        const pcm = decodeMuLawToPcm16(new Uint8Array(Buffer.from(media.payload, "base64")));
        for (const sample of pcm) downlinkPeak = Math.max(downlinkPeak, Math.abs(sample));
      }
      return;
    }
    if (msg.event === "clear") {
      clearReceived = true;
      if (clearAtMs === null) clearAtMs = Date.now() - startedAt;
    }
  });

  socket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
  socket.send(JSON.stringify({
    event: "start",
    streamSid,
    start: { streamSid, callSid, mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 } },
  }));

  const sendMulawFrame = (frame: Int16Array): void => {
    socket.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: Buffer.from(encodePcm16ToMuLaw(frame)).toString("base64") },
    }));
  };

  const pcm8k = downsampleTo8k(readPcm16Mono16kWav(FIXTURE_PATH));
  for (let offset = 0; offset < pcm8k.length; offset += FRAME_SAMPLES_8K) {
    const frame = new Int16Array(FRAME_SAMPLES_8K);
    frame.set(pcm8k.subarray(offset, Math.min(offset + FRAME_SAMPLES_8K, pcm8k.length)));
    sendMulawFrame(frame);
    await sleep(20);
  }

  // Padding silence until the agent answers (Deepgram endpointing + kuralle + TTS).
  const answerDeadline = Date.now() + 60_000;
  while (firstMediaAtMs === null && Date.now() < answerDeadline) {
    sendMulawFrame(new Int16Array(FRAME_SAMPLES_8K));
    await sleep(20);
  }
  if (firstMediaAtMs === null) throw new Error("no downlink media from the agent within 60s");

  // Barge-in on the phone leg: talk over the answer, expect a `clear` event.
  const bargeDeadline = Date.now() + 25_000;
  let offset = 0;
  while (!clearReceived && Date.now() < bargeDeadline) {
    const frame = new Int16Array(FRAME_SAMPLES_8K);
    frame.set(pcm8k.subarray(offset % pcm8k.length, Math.min((offset % pcm8k.length) + FRAME_SAMPLES_8K, pcm8k.length)));
    sendMulawFrame(frame);
    offset += FRAME_SAMPLES_8K;
    await sleep(20);
  }

  socket.send(JSON.stringify({ event: "stop", streamSid }));
  await sleep(200);
  socket.close();

  const result: TwilioSmokeResult = {
    ok: mediaFramesReceived > 0 && downlinkPeak > 100 && clearReceived,
    wsUrl,
    mediaFramesReceived,
    downlinkPeak,
    firstMediaAtMs,
    clearReceived,
    clearAtMs,
  };
  await writeFile(join(OUTPUT_DIR, "summary.json"), JSON.stringify(result, null, 2));

  console.log(`\n=== CF TWILIO INGRESS PASS: ${result.ok ? "YES" : "NO"} ===`);
  console.log(`media frames received: ${result.mediaFramesReceived}`);
  console.log(`downlink peak (mu-law decoded): ${result.downlinkPeak}`);
  console.log(`first media at: ${result.firstMediaAtMs}ms`);
  console.log(`clear (barge-in) received: ${result.clearReceived} at ${result.clearAtMs}ms`);

  if (!result.ok) throw new Error("CF twilio ingress smoke failed");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
