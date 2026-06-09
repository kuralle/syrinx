// SPDX-License-Identifier: MIT
//
// G6a — grounded cost: per-turn token usage for the full kuralle agent (RAG+flows+skills),
// captured via the runtime's onTokensUpdate hook. gpt-4.1-mini. Reports input/output/total
// tokens per turn for keep-Q&A, skill, and flow-entry turns (each a fresh session).

import { pathToFileURL } from "node:url";
import { ensureRepoRootDotenv } from "../src/run-one-turn.js";
import { createFullUniversityRuntime } from "../src/university-agent-full.js";

interface Usage { inputTokens?: number; outputTokens?: number; totalTokens?: number }
interface RawUsage { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number; total_tokens?: number }

const TURNS: Array<{ label: string; input: string }> = [
  { label: "keep:deadline (RAG)", input: "What's the application deadline for the computer science masters?" },
  { label: "keep:scholarship (RAG+skill)", input: "What scholarships can I get and what's the deadline?" },
  { label: "flow-entry:book", input: "I'd like to book an appointment with an advisor." },
];

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  if (!process.env["OPENAI_API_KEY"]?.trim()) throw new Error("OPENAI_API_KEY required");

  const calls: Usage[] = [];
  const { runtime } = await createFullUniversityRuntime({
    onUsage: (u: RawUsage) => calls.push({
      inputTokens: u.prompt_tokens ?? u.input_tokens ?? 0,
      outputTokens: u.completion_tokens ?? u.output_tokens ?? 0,
      totalTokens: u.total_tokens ?? 0,
    }),
  });

  // gpt-4.1-mini pricing (USD per 1M tokens) — VERIFY against current OpenAI pricing.
  const IN_PER_M = 0.40, OUT_PER_M = 1.60;
  console.log("Per-turn token usage — full kuralle agent (gpt-4.1-mini), fresh session each turn\n");
  console.log("turn                            | calls | in_tok | out_tok | total | est $/turn");
  let grand = 0;
  for (const t of TURNS) {
    calls.length = 0;
    const handle = runtime.run({ input: t.input, sessionId: `cost-${t.label}-${Math.random()}`, userId: "cost" });
    for await (const _ of handle.events) { /* drain */ }
    await handle;
    const inTok = calls.reduce((a, c) => a + (c.inputTokens ?? 0), 0);
    const outTok = calls.reduce((a, c) => a + (c.outputTokens ?? 0), 0);
    const tot = inTok + outTok;
    const usd = (inTok / 1e6) * IN_PER_M + (outTok / 1e6) * OUT_PER_M;
    grand += usd;
    console.log(`${t.label.padEnd(31)} | ${String(calls.length).padStart(5)} | ${String(inTok).padStart(6)} | ${String(outTok).padStart(7)} | ${String(tot).padStart(5)} | $${usd.toFixed(5)}`);
  }
  console.log(`\nTotal est. for these 3 turns: $${grand.toFixed(5)} (pricing assumed in=$${IN_PER_M}/M out=$${OUT_PER_M}/M — verify current).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
