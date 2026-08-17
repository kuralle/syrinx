// SPDX-License-Identifier: MIT
//
// Live proof for the manual-activity-detection acceptance item: with Gemini's server
// VAD disabled, the model must respond ONLY after Syrinx sends activityEnd.
//
// The discriminating shape is a silence window, not a happy path. Streaming a whole
// question and then getting an answer proves nothing on its own — server VAD would do
// that too. So this run:
//
//   1. opens with manualActivityDetection: true (server VAD off),
//   2. sends activityStart, streams the real question WAV, sends NO activityEnd,
//   3. WAITS. With server VAD off the model must stay silent. If it speaks here, the
//      config did not take effect and the proof has failed — that is the assertion.
//   4. sends activityEnd via requestResponse(), and only now expects a response.
//
// Usage: npx tsx scripts/run-gemini-manual-vad-live-proof.ts [--quiet-window 8]

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { fromGeminiLive } from "@kuralle-syrinx/realtime";
import type { RealtimeEvent } from "@kuralle-syrinx/realtime";
import { ensureRepoRootDotenv, readPcm16Mono16kWav } from "../src/run-one-turn.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(SCRIPT_DIR, "..", "test", "fixtures", "university-cs-masters-deadline.wav");
const FRAME_SAMPLES = 320; // 20ms @ 16kHz

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  const apiKey = process.env["GEMINI_API_KEY"];
  if (!apiKey) throw new Error("GEMINI_API_KEY is required");
  const quietWindowSec = Number(arg("quiet-window", "8"));

  const adapter = fromGeminiLive({ apiKey, manualActivityDetection: true });
  const t0 = Date.now();
  const at = (): number => Date.now() - t0;

  let audioFramesBeforeActivityEnd = 0;
  let audioFramesAfterActivityEnd = 0;
  let firstAudioAfterActivityEndMs: number | null = null;
  let activityEndAtMs: number | null = null;
  const events: Array<{ atMs: number; type: string }> = [];

  void (async () => {
    for await (const ev of adapter.events as AsyncIterable<RealtimeEvent>) {
      if (ev.type === "audio") {
        if (activityEndAtMs === null) audioFramesBeforeActivityEnd += 1;
        else {
          audioFramesAfterActivityEnd += 1;
          firstAudioAfterActivityEndMs ??= at() - activityEndAtMs;
        }
        continue;
      }
      events.push({ atMs: at(), type: ev.type });
      if (ev.type === "error") console.log(`[${(at()/1000).toFixed(1)}s] error: ${ev.cause.message.slice(0,140)}`);
      else console.log(`[${(at()/1000).toFixed(1)}s] ${ev.type}`);
    }
  })();

  await adapter.open(new AbortController().signal);
  console.log(`[${(at()/1000).toFixed(1)}s] open resolved (manualActivityDetection: true)`);

  // Speech start — manual mode only; in server-VAD mode this surfaces an error instead.
  (adapter as unknown as { startUserActivity(): void }).startUserActivity();
  console.log(`[${(at()/1000).toFixed(1)}s] activityStart sent`);

  const pcm = readPcm16Mono16kWav(FIXTURE);
  for (let off = 0; off < pcm.length; off += FRAME_SAMPLES) {
    const frame = pcm.subarray(off, Math.min(off + FRAME_SAMPLES, pcm.length));
    adapter.sendAudio(new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength));
    await new Promise((r) => setTimeout(r, 20));
  }
  const audioDoneAtMs = at();
  console.log(`[${(audioDoneAtMs/1000).toFixed(1)}s] question audio streamed, NO activityEnd yet`);

  // THE ASSERTION: server VAD is off, so nothing should be generated in this window.
  await new Promise((r) => setTimeout(r, quietWindowSec * 1000));
  const spokeWithoutActivityEnd = audioFramesBeforeActivityEnd > 0;
  console.log(
    `[${(at()/1000).toFixed(1)}s] quiet window (${quietWindowSec}s) over — audio frames received: ${audioFramesBeforeActivityEnd}`,
  );

  activityEndAtMs = at();
  adapter.requestResponse!();
  console.log(`[${(activityEndAtMs/1000).toFixed(1)}s] activityEnd sent via requestResponse()`);

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && audioFramesAfterActivityEnd < 5) {
    await new Promise((r) => setTimeout(r, 200));
  }

  await adapter.close().catch(() => undefined);

  const respondedOnlyAfterActivityEnd = !spokeWithoutActivityEnd && audioFramesAfterActivityEnd > 0;
  const result = {
    proof: "gemini manual activity detection",
    verdict: respondedOnlyAfterActivityEnd ? "PASS" : "FAIL",
    spokeWithoutActivityEnd,
    audioFramesBeforeActivityEnd,
    audioFramesAfterActivityEnd,
    firstAudioAfterActivityEndMs,
    quietWindowSeconds: quietWindowSec,
    events,
  };
  console.log(`\n=== MANUAL VAD: ${result.verdict} ===`);
  console.log(JSON.stringify(result, null, 2));
  if (!respondedOnlyAfterActivityEnd) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exit(1); });
