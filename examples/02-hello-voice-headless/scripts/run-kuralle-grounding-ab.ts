// SPDX-License-Identifier: MIT
//
// Reproduces the aria-flow/kuralle grounding-latency A/B (ADR 0008) IN SYRINX:
// the same full agent (RAG + 2 flows + skill) run in two modes — guaranteed
// (`autoRetrieve:true`, pre-inject every answering turn) vs on-demand
// (`autoRetrieve:false`, model calls a `knowledge_search` tool only when it answers).
// Each test utterance runs as turn-1 of a FRESH session (so routing turns are clean
// host turns, not flow resumes). Counts `knowledge-search` events per turn + TTFT.
// The clean proof is the per-turn retrieval COUNT on routing turns.

import { pathToFileURL } from "node:url";

import { ensureRepoRootDotenv } from "../src/run-one-turn.js";
import { createFullUniversityRuntime } from "../src/university-agent-full.js";

const REPS = 4;

interface Utterance { label: string; kind: "answer" | "route"; input: string }
const SCRIPT: Utterance[] = [
  { label: "answer:deadline",   kind: "answer", input: "What's the application deadline for the computer science masters?" },
  { label: "answer:tuition",    kind: "answer", input: "How much is tuition per semester?" },
  { label: "route:book",        kind: "route",  input: "I'd like to book an appointment with an advisor." },
  { label: "route:transcript",  kind: "route",  input: "I need to request my official transcript." },
];

interface RunPart { type: string }

async function runOnce(runtime: Awaited<ReturnType<typeof createFullUniversityRuntime>>["runtime"], input: string, sessionId: string) {
  const t0 = performance.now();
  let ttftMs = 0;
  let retrievals = 0;
  let flowEnter = false;
  const handle = runtime.run({ input, sessionId, userId: "ab" });
  for await (const raw of handle.events as AsyncIterable<RunPart>) {
    const p = raw as RunPart & { delta?: string };
    if (p.type === "knowledge-search") retrievals += 1;
    else if (p.type === "flow-enter") flowEnter = true;
    else if (p.type === "text-delta" && ttftMs === 0) ttftMs = performance.now() - t0;
  }
  await handle;
  return { ttftMs, retrievals, flowEnter };
}

async function measureMode(label: string, autoRetrieve: boolean) {
  const { runtime, ingestMs } = await createFullUniversityRuntime({ autoRetrieve });
  console.log(`\n### mode=${label} (autoRetrieve=${autoRetrieve})  ingestMs=${Math.round(ingestMs)}`);
  const rows: Array<{ label: string; kind: string; retMean: number; ttftMean: number; routed: number }> = [];
  for (const u of SCRIPT) {
    let retSum = 0, ttftSum = 0, routedCount = 0;
    for (let i = 0; i < REPS; i++) {
      const r = await runOnce(runtime, u.input, `ab-${label}-${u.label}-${i}-${Math.random()}`);
      retSum += r.retrievals; ttftSum += r.ttftMs; routedCount += r.flowEnter ? 1 : 0;
    }
    const row = { label: u.label, kind: u.kind, retMean: retSum / REPS, ttftMean: Math.round(ttftSum / REPS), routed: routedCount };
    rows.push(row);
    console.log(`  ${u.label.padEnd(18)} kind=${u.kind.padEnd(6)} #ret(mean)=${row.retMean.toFixed(2)}  TTFT=${row.ttftMean}ms  routed=${routedCount}/${REPS}`);
  }
  return rows;
}

async function main() {
  ensureRepoRootDotenv();
  if (!process.env["OPENAI_API_KEY"]?.trim()) throw new Error("OPENAI_API_KEY required");
  console.log(`Grounding A/B in syrinx — kuralle 0.7.1, gpt-4.1-mini, ${REPS} reps/utterance/mode`);

  const guaranteed = await measureMode("guaranteed", true);
  const onDemand = await measureMode("on-demand", false);

  console.log(`\n=== A/B: retrievals per turn (mean of ${REPS}) — the clean proof ===`);
  console.log(`utterance           kind    guaranteed#ret   on-demand#ret`);
  for (let i = 0; i < SCRIPT.length; i++) {
    const g = guaranteed[i]!, o = onDemand[i]!;
    console.log(`${g.label.padEnd(18)}  ${g.kind.padEnd(6)}  ${g.retMean.toFixed(2).padStart(12)}   ${o.retMean.toFixed(2).padStart(12)}`);
  }
  const gRoute = guaranteed.filter((r) => r.kind === "route");
  const oRoute = onDemand.filter((r) => r.kind === "route");
  const gRouteRet = gRoute.reduce((a, r) => a + r.retMean, 0) / gRoute.length;
  const oRouteRet = oRoute.reduce((a, r) => a + r.retMean, 0) / oRoute.length;
  console.log(`\nROUTING turns: guaranteed avg #ret=${gRouteRet.toFixed(2)}  on-demand avg #ret=${oRouteRet.toFixed(2)}`);
  console.log(oRouteRet < gRouteRet ? "REPRODUCED: on-demand eliminates routing-turn retrieval tax." : "NOT reproduced (investigate).");
  const oAnswer = onDemand.filter((r) => r.kind === "answer");
  const oAnswerRet = oAnswer.reduce((a, r) => a + r.retMean, 0) / oAnswer.length;
  console.log(`On-demand ANSWER turns avg #ret=${oAnswerRet.toFixed(2)} (tradeoff: <1.0 means the model sometimes answered ungrounded).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
