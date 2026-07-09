// SPDX-License-Identifier: MIT
//
// Reasoner-latency gate (RFC docs/rfc-reasoner-latency.md, WBS-5). Measures the
// LLM leg — reasoner stream(turn) -> first text-delta — for the composed levers
// vs a plain baseline. The composites (RoutingReasoner=Lever B, HedgedReasoner=
// Lever C) act ONLY on the LLM leg, so this is the honest, credit-bounded gate:
// does routing cut mean TTFT and does hedging cut the tail? Speculative start
// (Lever D) already ships as the `speculative` flag on ReasoningBridge and is NOT
// re-measured here (it overlaps STT settle, which this seam-level harness bypasses).
//
// Run: pnpm --filter @kuralle-syrinx/examples smoke:reasoner-latency-gate

import { config as loadDotenv } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createOpenAI } from "@ai-sdk/openai";
import {
  HedgedReasoner,
  RoutingReasoner,
  type Reasoner,
  type ReasonerTurn,
  type ReasoningPart,
} from "@kuralle-syrinx/core";
import { fromStreamText } from "@kuralle-syrinx/aisdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, "../../../.env") });

const DEEP = process.env["SYRINX_LLM_MODEL"]?.trim() || "gpt-4.1-mini";
const FAST = process.env["SYRINX_LLM_FAST_MODEL"]?.trim() || "gpt-4.1-nano";
const HEDGE_AFTER_MS = Number(process.env["SYRINX_HEDGE_AFTER_MS"] ?? 300);
const RUNS = Number(process.env["SYRINX_BENCH_RUNS"] ?? 10); // 1 warmup discarded

const SYSTEM = "You are a helpful university support assistant. Answer in one or two short sentences.";
const USER = "Hi, I'm applying for the computer science masters. What documents do I need?";

const openai = createOpenAI({ apiKey: process.env["OPENAI_API_KEY"]! });

function makeTurn(): ReasonerTurn {
  return { userText: USER, messages: [{ role: "system", content: SYSTEM }], signal: new AbortController().signal };
}

async function ttft(reasoner: Reasoner): Promise<number> {
  const t0 = performance.now();
  let ttftMs = -1;
  for await (const part of reasoner.stream(makeTurn()) as AsyncIterable<ReasoningPart>) {
    if (part.type === "text-delta" && ttftMs < 0) ttftMs = performance.now() - t0;
  }
  return ttftMs < 0 ? performance.now() - t0 : ttftMs;
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

async function bench(name: string, make: () => Reasoner): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    try {
      const t = await ttft(make());
      if (i > 0) samples.push(t); // discard warmup
    } catch (e) {
      console.error(`  ${name} run ${i} failed:`, (e as Error).message);
    }
  }
  const sorted = samples.slice().sort((a, b) => a - b);
  const p50 = pct(sorted, 50);
  const p95 = pct(sorted, 95);
  const max = sorted[sorted.length - 1] ?? NaN;
  console.log(
    `${name.padEnd(16)} TTFT  P50=${p50.toFixed(0)}ms  P95=${p95.toFixed(0)}ms  max=${max.toFixed(0)}ms  (n=${samples.length})`,
  );
  return samples;
}

const mkPlain = (model: string) => (): Reasoner => fromStreamText({ model: openai(model), system: SYSTEM });

async function main(): Promise<void> {
  console.log(`\n=== Reasoner-latency gate ===`);
  console.log(`deep=${DEEP}  fast=${FAST}  hedgeAfterMs=${HEDGE_AFTER_MS}  runs=${RUNS} (1 warmup discarded)\n`);

  // Baselines
  const deepSamples = await bench(`plain(${DEEP})`, mkPlain(DEEP));
  await bench(`plain(${FAST})`, mkPlain(FAST));

  // Lever C — HedgedReasoner: same deep model, primary + backup. Cuts the tail when
  // the primary's first token is slow (backup, started at hedgeAfterMs, can win).
  let hedgeFired = 0;
  let hedgeRuns = 0;
  const mkHedged = (): Reasoner =>
    new HedgedReasoner({
      primary: fromStreamText({ model: openai(DEEP), system: SYSTEM }),
      backup: fromStreamText({ model: openai(DEEP), system: SYSTEM }),
      hedgeAfterMs: HEDGE_AFTER_MS,
      bus: {
        // minimal metrics sink to count hedge.fired
        push: (_route: unknown, pkt: unknown) => {
          const p = pkt as { name?: string };
          if (p.name === "hedge.fired") hedgeFired++;
        },
      } as never,
    });
  const hedgedSamples = await bench(`hedged(${DEEP}x2)`, () => {
    hedgeRuns++;
    return mkHedged();
  });

  // Lever B — RoutingReasoner: classify by turn length; short turns -> fast model.
  let mispredict = 0;
  const classify = (turn: ReasonerTurn): string => (turn.userText.length < 60 ? "fast" : "deep");
  const mkRouted = (): Reasoner =>
    new RoutingReasoner({
      routes: [
        { id: "fast", reasoner: fromStreamText({ model: openai(FAST), system: SYSTEM }) },
        { id: "deep", reasoner: fromStreamText({ model: openai(DEEP), system: SYSTEM }) },
      ],
      classify,
      bus: {
        push: (_r: unknown, pkt: unknown) => {
          const p = pkt as { name?: string };
          if (p.name === "route.mispredict") mispredict++;
        },
      } as never,
    });
  await bench(`routed(fast/deep)`, mkRouted);

  // Composed — route deep turns through a hedged pair (B over C).
  const mkComposed = (): Reasoner =>
    new RoutingReasoner({
      routes: [
        { id: "fast", reasoner: fromStreamText({ model: openai(FAST), system: SYSTEM }) },
        { id: "deep", reasoner: mkHedged() },
      ],
      classify,
    });
  await bench(`composed(route→hedge)`, mkComposed);

  const dSorted = deepSamples.slice().sort((a, b) => a - b);
  const hSorted = hedgedSamples.slice().sort((a, b) => a - b);
  console.log(`\n--- cost / effect ---`);
  console.log(`hedge.fired: ${hedgeFired}/${hedgeRuns - 1} measured runs  (backup started; may or may not have won)`);
  console.log(`route.mispredict: ${mispredict}`);
  console.log(
    `tail effect (deep P95 ${pct(dSorted, 95).toFixed(0)}ms -> hedged P95 ${pct(hSorted, 95).toFixed(0)}ms)`,
  );
  console.log(
    `\nNote: v2v ≈ STT-final (~314-520ms) + LLM-TTFT (above) + TTS-TTFB (~270-320ms). The composites move the LLM leg;`,
  );
  console.log(`the <1s v2v gate additionally requires the fast route AND speculative-start overlap (Lever D, already shipped).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
