// SPDX-License-Identifier: MIT
//
// Media-lane parking proof against the deployed Workers/DO transport.
//
// Run:  npx tsx scripts/run-media-lane-cf-proof.ts \
//         --worker https://syrinx-media-lane-proof.mithushancj.workers.dev --repeats 3
//
// Same property, same verdict rule and same three arms as the Node proof
// (run-media-lane-parking-proof.ts) — read that file's header for why the arms are
// shaped this way and why a slow tool or an idle bed cannot discriminate.
//
// TWO THINGS DIFFER ON THE EDGE, both forced by the transport rather than chosen:
//
//  1. The arm is the sessionId PREFIX, not a separate deployment. One Worker serves
//     all three arms, so they run against byte-identical code and config. The previous
//     attempt deployed before/after as two builds from two git trees, which compares
//     more than the lane.
//
//  2. The client must report playout position (--emit-playout-progress). On the edge
//     the CLIENT is the playout clock: the server streams envelopes and the browser
//     schedules them, so `tts.playout_progress` reaches the bus only because a client
//     sends it (edge.ts maps it onto a Route.Main packet). The Node host paces
//     server-side and emits it itself.
//
// Each repeat gets a FRESH sessionId so runs never share a Durable Object instance.

import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const RUNS_DIR = join(PKG_ROOT, "test", "performance", "runs");

const ARMS = ["after", "before", "control"] as const;
type Arm = (typeof ARMS)[number];

const BASELINE_GAP_MS = 250;
const MIN_PARK_MS = 8000;

function arg(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1]?.trim() : undefined;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function run(args: readonly string[], tag: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", ...args], { cwd: PKG_ROOT, env: process.env });
    child.stdout.on("data", (c: Buffer) => process.stdout.write(`[${tag}] ${c.toString()}`));
    child.stderr.on("data", (c: Buffer) => process.stdout.write(`[${tag}!] ${c.toString()}`));
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

async function newestRunDir(before: ReadonlySet<string>): Promise<string | undefined> {
  const entries = await readdir(RUNS_DIR).catch(() => [] as string[]);
  return entries.filter((e) => e.startsWith("media-lane-harness-") && !before.has(e)).sort().at(-1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const worker = arg(argv, "--worker") ?? "https://syrinx-media-lane-proof.mithushancj.workers.dev";
  const repeats = Number.parseInt(arg(argv, "--repeats") ?? "3", 10);
  const delayMs = Number.parseInt(arg(argv, "--delay-ms") ?? "10000", 10);
  const wsBase = worker.replace(/^http/, "ws");

  const gaps = new Map<Arm, number[]>(ARMS.map((a) => [a, []]));
  const frameCounts = new Map<Arm, number[]>(ARMS.map((a) => [a, []]));

  for (let repeat = 0; repeat < repeats; repeat += 1) {
    for (const armName of ARMS) {
      const sessionId = `${armName}-${randomUUID()}`;
      const url = `${wsBase}/ws?sessionId=${encodeURIComponent(sessionId)}`;
      console.log(`\n=== ${armName} repeat ${repeat + 1}/${repeats} (${sessionId}) ===`);
      const seen = new Set(await readdir(RUNS_DIR).catch(() => [] as string[]));
      await run(
        [
          "scripts/run-media-lane-harness.ts",
          "--url", url,
          "--repeats", "1",
          "--delay-ms", String(delayMs),
          "--emit-playout-progress",
        ],
        `${armName}:${repeat + 1}`,
      );
      const dir = await newestRunDir(seen);
      if (!dir) continue;
      // A run that never reached `ready` leaves its directory with no artifact. Skip it
      // loudly rather than aborting the matrix -- one failed connection must not discard
      // the arms that did measure.
      const raw = await readFile(join(RUNS_DIR, dir, "artifact.json"), "utf8").catch(() => null);
      if (raw === null) {
        console.log(`[${armName}:${repeat + 1}] NO ARTIFACT — run did not complete; skipping`);
        continue;
      }
      const parsed = JSON.parse(raw) as {
        runs?: { wholeUtteranceGapMs?: { value?: number }; framesReceived?: number }[];
      };
      for (const r of parsed.runs ?? []) {
        if (typeof r.wholeUtteranceGapMs?.value === "number") gaps.get(armName)!.push(r.wholeUtteranceGapMs.value);
        if (typeof r.framesReceived === "number") frameCounts.get(armName)!.push(r.framesReceived);
      }
    }
  }

  const results = ARMS.map((armName) => {
    const values = gaps.get(armName)!;
    return {
      arm: armName,
      gapsMs: values,
      framesReceived: frameCounts.get(armName)!,
      medianGapMs: median(values),
      maxGapMs: values.length > 0 ? Math.max(...values) : null,
    };
  });
  const byArm = new Map(results.map((r) => [r.arm, r]));
  const before = byArm.get("before")!.medianGapMs;
  const after = byArm.get("after")!.medianGapMs;
  const control = byArm.get("control")!.medianGapMs;
  const PARKED_SCALE = delayMs * 0.25;

  const checks = {
    beforeParks: before !== null && before >= delayMs * 0.5,
    afterFlows: after !== null && after < BASELINE_GAP_MS,
    controlFlows: control !== null && control < BASELINE_GAP_MS,
    noAfterRunParked: byArm.get("after")!.maxGapMs !== null && byArm.get("after")!.maxGapMs! < PARKED_SCALE,
    noControlRunParked: byArm.get("control")!.maxGapMs !== null && byArm.get("control")!.maxGapMs! < PARKED_SCALE,
  };
  const verdict =
    before === null || after === null || control === null
      ? "inconclusive"
      : delayMs < MIN_PARK_MS && !checks.beforeParks
        ? "inconclusive"
        : Object.values(checks).every(Boolean)
          ? "passed"
          : "failed";

  console.log("\n========= MEDIA LANE PARKING PROOF — WORKERS/DO =========");
  for (const r of results) {
    console.log(
      `${r.arm.padEnd(8)} medianGapMs=${String(r.medianGapMs).padStart(6)} maxGapMs=${String(r.maxGapMs).padStart(6)}  ` +
        `gaps=${JSON.stringify(r.gapsMs)}  frames=${JSON.stringify(r.framesReceived)}`,
    );
  }
  console.log(`worker=${worker} delayMs=${delayMs} baselineGapMs=${BASELINE_GAP_MS} parkedScaleMs=${PARKED_SCALE}`);
  console.log(`playout buffer absorbed: ${String(before !== null ? delayMs - before : null)}ms of the before-arm park`);
  console.log(`checks: ${JSON.stringify(checks)}`);
  console.log(`VERDICT: ${verdict}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(RUNS_DIR, `media-lane-cf-proof-${stamp}`);
  await mkdir(outDir, { recursive: true });
  await writeFile(
    join(outDir, "artifact.json"),
    `${JSON.stringify(
      { scenario: "media_lane_parking_proof_workers", generatedAt: new Date().toISOString(), worker, delayMs, repeats, baselineGapMs: BASELINE_GAP_MS, minParkMs: MIN_PARK_MS, parkedScaleMs: PARKED_SCALE, results, checks, verdict },
      null,
      2,
    )}\n`,
  );
  console.log(`artifact: ${outDir}/artifact.json`);
  if (verdict !== "passed") process.exitCode = 1;
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
