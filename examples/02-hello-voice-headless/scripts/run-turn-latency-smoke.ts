// SPDX-License-Identifier: MIT
//
// Release gate: `turn_latency` must fire, with a real anchor, on BOTH fronts.
//
// Why this exists as a live smoke rather than a unit test — this is the whole point:
//
// `turn_latency` never fired on the native realtime front for the entire life of the
// feature. Three consecutive fix attempts passed the unit suite (294, then 295 tests,
// all green) and failed live. The suite could not catch it because every turn_latency
// unit test hardcodes a single `contextId`, while the bug was about identity changing
// mid-turn: `speech_stopped` arrives before `response_started`, when the bridge's
// contextId is still empty, so the speech-end anchor was dropped and no timing record
// existed when the emit ran.
//
// A test author picks one contextId and moves on. Only a real session varies it. So the
// acceptance criterion for this instrument is a live turn, and this script is that
// criterion made runnable.
//
// Run: pnpm smoke:turn-latency          (both arms)
//      SYRINX_SMOKE_ARM=cascade pnpm smoke:turn-latency
//
// Requires live provider keys (OpenAI + Deepgram + Cartesia). Exits non-zero on failure
// so it can gate a release.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SPIKE = fileURLToPath(new URL("./spike-turn-decomposition-live.ts", import.meta.url));

interface ArmResult {
  readonly arm: string;
  readonly fired: boolean;
  readonly anchor: string | null;
  readonly ttfaMs: number | null;
  readonly stages: number;
  readonly output: string;
}

async function runArm(arm: "cascade" | "native"): Promise<ArmResult> {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn("npx", ["tsx", SPIKE], {
      env: { ...process.env, SYRINX_SPIKE_ARM: arm },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    child.stdout.on("data", (d: Buffer) => (buf += d.toString()));
    child.stderr.on("data", (d: Buffer) => (buf += d.toString()));
    child.on("error", reject);
    child.on("close", () => resolve(buf));
  });

  const fired = !output.includes("turn_latency never fired");
  const anchor = /anchor=(\w+)/.exec(output)?.[1] ?? null;
  const ttfa = /ttfaMs\s+(\d+)ms/.exec(output)?.[1];
  // Count named stages that resolved to a real number rather than n/a.
  const stages = ["eouDelayMs", "llmTtftMs", "textAggregationMs", "ttsTtfbMs"].filter((f) =>
    new RegExp(`${f}\\s+\\d+ms`).test(output),
  ).length;

  return { arm, fired, anchor, ttfaMs: ttfa ? Number(ttfa) : null, stages, output };
}

async function main(): Promise<void> {
  const only = process.env["SYRINX_SMOKE_ARM"]?.trim();
  const arms: Array<"cascade" | "native"> =
    only === "cascade" || only === "native" ? [only] : ["cascade", "native"];

  const results: ArmResult[] = [];
  for (const arm of arms) {
    console.log(`\n=== ${arm} ===`);
    const r = await runArm(arm);
    results.push(r);
    console.log(
      `  fired=${String(r.fired)}  anchor=${r.anchor ?? "-"}  ttfaMs=${r.ttfaMs ?? "-"}  stages=${r.stages}/4`,
    );
  }

  const failures: string[] = [];
  for (const r of results) {
    // The regression this gate exists for: the event silently not firing at all.
    if (!r.fired) failures.push(`${r.arm}: turn_latency never fired`);
    else if (r.anchor === null) failures.push(`${r.arm}: fired without an anchor`);
    else if (r.ttfaMs === null) failures.push(`${r.arm}: fired without a ttfaMs`);
    // A front that reports a total but zero stages is the "instrument is on but blind"
    // state — worth failing on, because it looks healthy on a dashboard.
    else if (r.stages === 0) failures.push(`${r.arm}: no stage resolved (total-only)`);
  }

  console.log("");
  if (failures.length > 0) {
    console.error("TURN-LATENCY SMOKE FAILED:");
    for (const f of failures) console.error(`  - ${f}`);
    for (const r of results.filter((x) => !x.fired)) {
      console.error(`\n--- ${r.arm} raw output ---\n${r.output}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`TURN-LATENCY SMOKE PASSED (${results.map((r) => r.arm).join(", ")})`);
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
