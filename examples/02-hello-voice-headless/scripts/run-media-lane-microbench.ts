// SPDX-License-Identifier: MIT
//
// Client for the provider-free Workers/DO media-lane microbenchmark.
//
//   npx tsx scripts/run-media-lane-microbench.ts --trials 40 --park-ms 3000
//
// Arms are INTERLEAVED within one batch, not run as consecutive blocks. Three earlier
// diagnosis attempts were voided because each arm ran in its own batch and the fault
// varies over time, so a clean batch could mean the fix worked or the platform was
// quiet. Interleaving makes every arm see the same conditions.

import WebSocket from "ws";

const WORKER = "wss://syrinx-media-lane-microbench.mithushancj.workers.dev";

interface Trial {
  readonly arm: string;
  readonly gapMs: number;
  readonly frames: number;
}

function arg(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1]?.trim() : undefined;
}

async function runTrial(arm: string, query: string, parkMs: number, path = "/ws"): Promise<Trial> {
  const url = `${WORKER}${path}?sessionId=${arm}-${Math.random().toString(36).slice(2)}&${query}`;
  const socket = new WebSocket(url);
  const arrivals: number[] = [];
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => resolve(), parkMs + 15_000);
    socket.on("message", (_data, isBinary) => {
      if (isBinary) arrivals.push(Date.now());
    });
    socket.on("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
  try {
    socket.close();
  } catch {
    /* already closed */
  }
  let gapMs = 0;
  for (let index = 1; index < arrivals.length; index += 1) {
    const gap = arrivals[index]! - arrivals[index - 1]!;
    if (gap > gapMs) gapMs = gap;
  }
  return { arm, gapMs, frames: arrivals.length };
}

function summarize(label: string, trials: readonly Trial[], parkMs: number): void {
  const gaps = trials.map((t) => t.gapMs).sort((a, b) => a - b);
  if (gaps.length === 0) {
    console.log(`${label.padEnd(22)} no trials`);
    return;
  }
  const median = gaps[Math.floor(gaps.length / 2)]!;
  // "Stalled" means a gap at the order of the park, which is categorically different
  // from frame jitter — not a tuned threshold.
  const stalled = trials.filter((t) => t.gapMs >= parkMs * 0.5).length;
  console.log(
    `${label.padEnd(22)} stalled=${String(stalled).padStart(3)}/${String(trials.length).padEnd(3)} ` +
      `median=${String(median).padStart(5)}ms max=${String(gaps.at(-1)).padStart(5)}ms ` +
      `avgFrames=${Math.round(trials.reduce((s, t) => s + t.frames, 0) / trials.length)}`,
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const trials = Number.parseInt(arg(argv, "--trials") ?? "30", 10);
  const parkMs = Number.parseInt(arg(argv, "--park-ms") ?? "3000", 10);
  const frames = Number.parseInt(arg(argv, "--frames") ?? "400", 10);

  const arms = [
    { name: "main", query: `mode=main&probe=none&parkMs=${parkMs}&frames=${frames}` },
    { name: "concurrent", query: `mode=concurrent&probe=none&parkMs=${parkMs}&frames=${frames}` },
    { name: "no-park", query: `mode=none&probe=none&parkMs=${parkMs}&frames=${frames}` },
    { name: "main+unconfirmed", query: `mode=main&probe=unconfirmed&parkMs=${parkMs}&frames=${frames}` },
    // The one that matters: identical bench, frames leave through an agents-SDK
    // Connection instead of a raw WebSocketPair. That is the only layer the raw arms
    // omit and the real host includes.
    { name: "agents-main", query: `mode=main&probe=none&parkMs=${parkMs}&frames=${frames}`, path: "/agent-ws" },
    { name: "agents-no-park", query: `mode=none&probe=none&parkMs=${parkMs}&frames=${frames}`, path: "/agent-ws" },
  ] as const;

  const results = new Map<string, Trial[]>(arms.map((a) => [a.name, []]));
  for (let round = 0; round < trials; round += 1) {
    for (const armSpec of arms) {
      try {
        const trial = await runTrial(armSpec.name, armSpec.query, parkMs, (armSpec as { path?: string }).path ?? "/ws");
        results.get(armSpec.name)!.push(trial);
      } catch (err) {
        console.log(`  ${armSpec.name} round ${round + 1} failed: ${String(err)}`);
      }
    }
    if ((round + 1) % 5 === 0) console.log(`  … ${round + 1}/${trials} rounds`);
  }

  console.log(`\n===== MEDIA LANE MICROBENCH (parkMs=${parkMs}, interleaved) =====`);
  for (const armSpec of arms) summarize(armSpec.name, results.get(armSpec.name)!, parkMs);
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
