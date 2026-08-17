// SPDX-License-Identifier: MIT
//
// Three-arm live proof that the media lane keeps `tts.audio` flowing while a Main-lane
// consumer handler is parked on real I/O.
//
// Run:  npx tsx scripts/run-media-lane-parking-proof.ts --repeats 3
//
// Reads: media-lane-proof-agent.ts explains WHY the arms are shaped this way and why
// the earlier slow-tool fixture could not discriminate. Do not restate it here.
//
// Verdict rule (all three must hold, else INCONCLUSIVE):
//   before  gap >= 0.5 * delayMs      — parking is visible when the lane is disabled
//   after   gap <  BASELINE_GAP_MS    — the shipped lane keeps media flowing
//   control gap <  BASELINE_GAP_MS    — a zero-delay run does NOT gap, so the before
//                                       figure is caused by the block and not by the
//                                       demoted routing, the fixture, or the network

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startMediaLaneDelayServer } from "./media-lane-delay-server.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const RUNS_DIR = join(PKG_ROOT, "test", "performance", "runs");

const ARMS = ["after", "before", "control"] as const;
type Arm = (typeof ARMS)[number];

const BASELINE_GAP_MS = 250;
// The park must outlast the paced-playout buffer, or the buffer simply absorbs it and
// the run reads as a refutation when nothing was refuted. MEASURED 2026-08-17: a 2000ms
// park produced only a 121-138ms gap in the before arm, because the transport already
// held ~2.5s of synthesized audio (TTS outruns realtime playout); the same fixture at
// 10000ms produced 7483ms — i.e. 10000 - 7483 = ~2517ms absorbed, agreeing with the
// 2000ms result. Below this floor the experiment cannot discriminate, so it reports
// inconclusive rather than failed.
const MIN_PARK_MS = 8000;
const SERVER_READY_TIMEOUT_MS = 60_000;

function arg(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1]?.trim() : undefined;
}

async function newestRunDir(before: ReadonlySet<string>): Promise<string | undefined> {
  const entries = await readdir(RUNS_DIR).catch(() => [] as string[]);
  const fresh = entries.filter((e) => e.startsWith("media-lane-harness-") && !before.has(e)).sort();
  return fresh.at(-1);
}

function waitForReady(child: ChildProcessWithoutNullStreams, arm: Arm): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`[${arm}] dev server never printed its WebSocket endpoint`)),
      SERVER_READY_TIMEOUT_MS,
    );
    let buffered = "";
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString();
      buffered += text;
      process.stdout.write(`[${arm}:server] ${text}`);
      const match = /WebSocket endpoint: (ws:\/\/\S+)/.exec(buffered);
      if (!match) return;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stdout.on("data", (c: Buffer) => process.stdout.write(`[${arm}:server] ${c.toString()}`));
      resolve(match[1]!);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (c: Buffer) => process.stdout.write(`[${arm}:server!] ${c.toString()}`));
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`[${arm}] dev server exited early with code ${String(code)}`));
    });
  });
}

function run(cmd: string, args: readonly string[], env: NodeJS.ProcessEnv, tag: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, [...args], { cwd: PKG_ROOT, env: { ...process.env, ...env } });
    child.stdout.on("data", (c: Buffer) => process.stdout.write(`[${tag}] ${c.toString()}`));
    child.stderr.on("data", (c: Buffer) => process.stdout.write(`[${tag}!] ${c.toString()}`));
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 8000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

interface ArmResult {
  readonly arm: Arm;
  readonly gapsMs: readonly (number | null)[];
  readonly maxGapMs: number | null;
  readonly medianGapMs: number | null;
  readonly framesReceived: readonly number[];
  readonly runDir?: string;
  readonly harnessExitCode: number;
}

async function runArm(arm: Arm, delayUrl: string, delayMs: number, repeats: number, port: number): Promise<ArmResult> {
  console.log(`\n=== ARM ${arm} ===`);
  const server = spawn(
    "npx",
    ["tsx", "scripts/dev-server.ts", "--agent", "scripts/media-lane-proof-agent.ts#createSession"],
    {
      cwd: PKG_ROOT,
      env: {
        ...process.env,
        SYRINX_PROOF_ARM: arm,
        SYRINX_MEDIA_LANE_DELAY_URL: delayUrl,
        SYRINX_PROOF_DELAY_MS: String(delayMs),
        SYRINX_DEV_PORT: String(port),
      },
    },
  ) as ChildProcessWithoutNullStreams;

  try {
    const wsUrl = await waitForReady(server, arm);
    const seen = new Set(await readdir(RUNS_DIR).catch(() => [] as string[]));
    const harnessExitCode = await run(
      "npx",
      [
        "tsx", "scripts/run-media-lane-harness.ts",
        "--url", wsUrl,
        "--repeats", String(repeats),
        "--delay-url", delayUrl,
        "--delay-ms", String(delayMs),
      ],
      {},
      `${arm}:harness`,
    );

    const runDir = await newestRunDir(seen);
    let gapsMs: (number | null)[] = [];
    let framesReceived: number[] = [];
    if (runDir) {
      const raw = await readFile(join(RUNS_DIR, runDir, "artifact.json"), "utf8");
      const parsed = JSON.parse(raw) as {
        runs?: { wholeUtteranceGapMs?: { value?: number }; framesReceived?: number }[];
      };
      gapsMs = (parsed.runs ?? []).map((r) => r.wholeUtteranceGapMs?.value ?? null);
      framesReceived = (parsed.runs ?? []).map((r) => r.framesReceived ?? 0);
    }
    const measured = gapsMs.filter((g): g is number => g !== null);
    return {
      arm,
      gapsMs,
      maxGapMs: measured.length > 0 ? Math.max(...measured) : null,
      medianGapMs: median(measured),
      framesReceived,
      ...(runDir ? { runDir } : {}),
      harnessExitCode,
    };
  } finally {
    await stop(server);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const repeats = Number.parseInt(arg(argv, "--repeats") ?? "3", 10);
  const delayMs = Number.parseInt(arg(argv, "--delay-ms") ?? "2000", 10);

  const basePort = Number.parseInt(arg(argv, "--base-port") ?? "4310", 10);
  const delayServer = await startMediaLaneDelayServer({ defaultDelayMs: delayMs });
  console.log(`delay server: ${delayServer.url}`);

  const results: ArmResult[] = [];
  try {
    for (const arm of ARMS) {
      results.push(await runArm(arm, delayServer.url, delayMs, repeats, basePort + ARMS.indexOf(arm)));
    }
  } finally {
    await delayServer.close();
  }

  const byArm = new Map(results.map((r) => [r.arm, r]));
  // Median, not max. MEASURED 2026-08-17: one after-arm run in three read 591ms while
  // carrying 518 frames against 795-811 in its siblings — a short/hiccuping turn, not a
  // parked lane. The two are separable by SCALE, not by taste: a parked lane reads at the
  // order of the park (7672-7890ms here), so PARKED_SCALE below rejects any run that
  // actually looks parked, while the median absorbs provider jitter. Reporting max alone
  // would let one provider hiccup veto a real result; reporting median alone would hide a
  // genuine intermittent park. Both are required, and both are printed.
  const before = byArm.get("before")?.medianGapMs ?? null;
  const after = byArm.get("after")?.medianGapMs ?? null;
  const control = byArm.get("control")?.medianGapMs ?? null;
  const PARKED_SCALE = delayMs * 0.25;
  const worstAfter = byArm.get("after")?.maxGapMs ?? null;
  const worstControl = byArm.get("control")?.maxGapMs ?? null;

  const checks = {
    beforeParks: before !== null && before >= delayMs * 0.5,
    afterFlows: after !== null && after < BASELINE_GAP_MS,
    controlFlows: control !== null && control < BASELINE_GAP_MS,
    noAfterRunParked: worstAfter !== null && worstAfter < PARKED_SCALE,
    noControlRunParked: worstControl !== null && worstControl < PARKED_SCALE,
  };
  const verdict =
    before === null || after === null || control === null
      ? "inconclusive"
      : delayMs < MIN_PARK_MS && !checks.beforeParks
        ? "inconclusive"
        : Object.values(checks).every(Boolean)
          ? "passed"
          : "failed";
  const absorbedMs = before !== null ? delayMs - before : null;

  console.log("\n================ MEDIA LANE PARKING PROOF ================");
  for (const r of results) {
    console.log(
      `${r.arm.padEnd(8)} medianGapMs=${String(r.medianGapMs).padStart(6)} maxGapMs=${String(r.maxGapMs).padStart(6)}  ` +
        `gaps=${JSON.stringify(r.gapsMs)}  frames=${JSON.stringify(r.framesReceived)}  ` +
        `harnessExit=${r.harnessExitCode}`,
    );
  }
  console.log(`delayMs=${delayMs} baselineGapMs=${BASELINE_GAP_MS} minParkMs=${MIN_PARK_MS}`);
  console.log(`playout buffer absorbed: ${String(absorbedMs)}ms of the before-arm park`);
  if (verdict === "inconclusive" && before !== null && delayMs < MIN_PARK_MS) {
    console.log(
      `INCONCLUSIVE: park ${delayMs}ms did not outlast the playout buffer (~${String(absorbedMs)}ms ` +
        `absorbed). Re-run with --delay-ms >= ${MIN_PARK_MS}. This is NOT evidence against the lane.`,
    );
  }
  console.log(`checks: ${JSON.stringify(checks)}`);
  console.log(`VERDICT: ${verdict}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(RUNS_DIR, `media-lane-parking-proof-${stamp}`);
  await mkdir(outDir, { recursive: true });
  await writeFile(
    join(outDir, "artifact.json"),
    `${JSON.stringify(
      { scenario: "media_lane_parking_proof", generatedAt: new Date().toISOString(), delayMs, repeats, baselineGapMs: BASELINE_GAP_MS, minParkMs: MIN_PARK_MS, parkedScaleMs: PARKED_SCALE, absorbedMs, results, checks, verdict },
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
