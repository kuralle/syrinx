// SPDX-License-Identifier: MIT
//
// Live proof for the goAway acceptance item: a Gemini Live session driven past the
// ~9-minute connection-duration limit must keep running.
//
// Two arms, ONE driver, so the only variable is the adapter:
//   --arm before  → the exact pre-fix adapter (zz-pregoaway-adapter.ts, extracted from
//                   6f5daee~1). It contains ZERO references to `goAway`. Expected: the
//                   event stream completes near ~590s — the drop this task exists to fix.
//   --arm after   → the shipped adapter. Expected: a scheduled reconnect inside the
//                   goAway window, and the stream still open past 590s.
//
// A before-arm that does NOT drop means the harness cannot detect the defect, and the
// after-arm proves nothing — that is the failure mode this two-arm shape exists to catch.
//
// Keepalive is silent 16 kHz PCM every 200ms, the same shape the 2026-08-16 spike used
// to observe goAway at 540s with timeLeft "50s". Silence keeps provider spend near zero:
// the model is never asked to generate.
//
// Usage: npx tsx scripts/run-gemini-goaway-live-proof.ts --arm before|after [--seconds 700]

import { ensureRepoRootDotenv } from "../src/run-one-turn.js";
import { fromGeminiLive } from "@kuralle-syrinx/realtime";
import type { RealtimeAdapter, RealtimeEvent } from "@kuralle-syrinx/realtime";

const FRAME_MS = 200;
const SAMPLE_RATE_HZ = 16_000;
const SILENT_FRAME = new Uint8Array((SAMPLE_RATE_HZ / 1000) * FRAME_MS * 2); // PCM16 zeros

interface Mark { readonly atMs: number; readonly what: string; readonly detail?: string }

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  const apiKey = process.env["GEMINI_API_KEY"];
  if (!apiKey) throw new Error("GEMINI_API_KEY is required");

  const armName = arg("arm", "after");
  if (armName !== "before" && armName !== "after") throw new Error(`--arm must be before|after`);
  const runSeconds = Number(arg("seconds", "700"));

  // The before arm needs the EXACT pre-fix adapter. It is not committed — a second copy
  // of an adapter is a maintenance trap — so regenerate it on demand:
  //
  //   git show 6f5daee~1:packages/realtime/src/from-gemini-live.ts \
  //     | sed 's/export function fromGeminiLive(/export function fromGeminiLivePreFix(/' \
  //     > packages/realtime/src/zz-pregoaway-adapter.ts
  //
  // and delete it again afterwards. That commit is the parent of the goAway fix, and the
  // file it produces contains ZERO references to `goAway`.
  let make = fromGeminiLive as (o: { apiKey: string }) => RealtimeAdapter;
  if (armName === "before") {
    // Specifier built at runtime so `tsc` does not resolve a file that is deliberately
    // absent from the tree — the before arm regenerates it, the repo never carries it.
    const preFixSpecifier = ["..", "..", "..", "packages", "realtime", "src", "zz-pregoaway-adapter.js"].join("/");
    const mod = await import(preFixSpecifier).catch(() => {
      throw new Error(
        "before arm needs packages/realtime/src/zz-pregoaway-adapter.ts — regenerate it with the git show command in this file's header",
      );
    });
    make = (mod as { fromGeminiLivePreFix: (o: { apiKey: string }) => RealtimeAdapter })
      .fromGeminiLivePreFix;
  }
  const adapter: RealtimeAdapter = make({ apiKey });

  const t0 = Date.now();
  const at = (): number => Date.now() - t0;
  const marks: Mark[] = [];
  const mark = (what: string, detail?: string): void => {
    const m: Mark = { atMs: at(), what, ...(detail !== undefined ? { detail } : {}) };
    marks.push(m);
    console.log(`[${(m.atMs / 1000).toFixed(1)}s] ${what}${detail ? ` — ${detail}` : ""}`);
  };

  let streamClosedAtMs: number | null = null;
  let handles = 0;

  const consumer = (async () => {
    for await (const ev of adapter.events as AsyncIterable<RealtimeEvent>) {
      if (ev.type === "resumption_handle") { handles += 1; continue; }
      if (ev.type === "error") {
        mark(/reestablish/i.test(ev.cause.message) ? "RECONNECT" : "error", ev.cause.message.slice(0, 120));
        continue;
      }
      if (ev.type === "audio") continue;
      mark(`event:${ev.type}`);
    }
    streamClosedAtMs = at();
    mark("STREAM CLOSED", "adapter.events completed — the call is over");
  })();

  mark("open() start");
  await adapter.open(new AbortController().signal);
  mark("open() resolved");

  const deadline = Date.now() + runSeconds * 1000;
  while (Date.now() < deadline && streamClosedAtMs === null) {
    try { adapter.sendAudio(SILENT_FRAME); } catch (err) {
      mark("sendAudio threw", err instanceof Error ? err.message.slice(0, 120) : String(err));
      break;
    }
    await new Promise((r) => setTimeout(r, FRAME_MS));
  }

  const survivedMs = streamClosedAtMs ?? at();
  const survivedPastLimit = streamClosedAtMs === null;
  mark("run end", `survived ${(survivedMs / 1000).toFixed(1)}s, resumption handles seen: ${handles}`);

  await adapter.close().catch(() => undefined);
  await Promise.race([consumer, new Promise((r) => setTimeout(r, 2000))]);

  const verdict = survivedPastLimit ? "SURVIVED" : "DROPPED";
  const result = {
    arm: armName,
    verdict,
    ranForSeconds: Number((survivedMs / 1000).toFixed(1)),
    streamClosedAtSeconds: streamClosedAtMs === null ? null : Number((streamClosedAtMs / 1000).toFixed(1)),
    resumptionHandles: handles,
    reconnects: marks.filter((m) => m.what === "RECONNECT").length,
    marks,
  };
  console.log(`\n=== ${armName.toUpperCase()} ARM: ${verdict} ===`);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
