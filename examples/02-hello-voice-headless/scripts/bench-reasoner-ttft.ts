// SPDX-License-Identifier: MIT
//
// Apples-to-apples reasoner TTFT benchmark: AI SDK (fromStreamText) vs Mastra
// (fromMastraAgent) vs Kuralle (fromKuralleRuntime). Bypasses STT/TTS entirely —
// measures only stream(turn) -> first text-delta, same model + prompt + input.
// For Kuralle it ALSO timestamps every internal HarnessStreamPart phase so we can
// localize where the pre-first-token time goes (openRun vs node-enter vs model).

import { config as loadDotenv } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createOpenAI } from "@ai-sdk/openai";
import { Agent } from "@mastra/core/agent";
import { defineAgent, createRuntime, MemoryStore } from "@kuralle-agents/core";

import type { Reasoner, ReasonerTurn, ReasoningPart } from "@kuralle-syrinx/core";
import { fromStreamText } from "@kuralle-syrinx/aisdk";
import { fromMastraAgent, type MastraAgentLike } from "@kuralle-syrinx/mastra";
import { fromKuralleRuntime, type KuralleRuntimeLike } from "@kuralle-syrinx/kuralle";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, "../../../.env") });

const MODEL = process.env["SYRINX_LLM_MODEL"]?.trim() || "gpt-4.1-mini";
const SYSTEM = "You are a helpful university support assistant. Answer in one or two short sentences.";
const USER = "Hi, I'm applying for the computer science masters. What documents do I need?";
const RUNS = 5; // 1 warmup (discarded) + 4 measured

function makeTurn(): ReasonerTurn {
  return { userText: USER, messages: [{ role: "system", content: SYSTEM }], signal: new AbortController().signal };
}

async function ttft(reasoner: Reasoner): Promise<{ ttftMs: number; doneMs: number; chars: number }> {
  const t0 = performance.now();
  let ttftMs = -1;
  let chars = 0;
  for await (const part of reasoner.stream(makeTurn()) as AsyncIterable<ReasoningPart>) {
    if (part.type === "text-delta") {
      if (ttftMs < 0) ttftMs = performance.now() - t0;
      chars += part.text.length;
    }
  }
  return { ttftMs, doneMs: performance.now() - t0, chars };
}

async function bench(name: string, make: () => Reasoner): Promise<void> {
  const samples: number[] = [];
  let last = { ttftMs: 0, doneMs: 0, chars: 0 };
  for (let i = 0; i < RUNS; i++) {
    last = await ttft(make());
    if (i > 0) samples.push(last.ttftMs); // discard warmup
  }
  const med = samples.slice().sort((a, b) => a - b)[Math.floor(samples.length / 2)];
  console.log(
    `${name.padEnd(10)} TTFT median=${med.toFixed(0)}ms  (samples=${samples.map((s) => s.toFixed(0)).join(",")})  lastDone=${last.doneMs.toFixed(0)}ms chars=${last.chars}`,
  );
}

// Kuralle phase-timing: iterate the raw runtime events once and log t_ms per phase.
async function kuralleTrace(runtime: KuralleRuntimeLike): Promise<void> {
  const t0 = performance.now();
  const handle = runtime.run({ input: USER, sessionId: "bench-trace" });
  const seen = new Set<string>();
  for await (const p of handle.events as AsyncIterable<{ type: string }>) {
    const t = (performance.now() - t0).toFixed(0);
    if (p.type === "text-delta") {
      if (!seen.has("first-text")) {
        seen.add("first-text");
        console.log(`  [kuralle trace] +${t}ms  FIRST text-delta`);
      }
    } else if (!seen.has(p.type)) {
      seen.add(p.type);
      console.log(`  [kuralle trace] +${t}ms  ${p.type}`);
    }
  }
  console.log(`  [kuralle trace] +${(performance.now() - t0).toFixed(0)}ms  stream end`);
}

async function main(): Promise<void> {
  const openai = createOpenAI({ apiKey: process.env["OPENAI_API_KEY"]! });
  console.log(`model=${MODEL}  runs=${RUNS} (1 warmup discarded)\n`);

  // AI SDK
  await bench("ai-sdk", () => fromStreamText({ model: openai(MODEL), system: SYSTEM }));

  // Mastra
  const mastra = new Agent({ id: "u", name: "u", instructions: SYSTEM, model: openai(MODEL) });
  await bench("mastra", () => fromMastraAgent(mastra as unknown as MastraAgentLike));

  // Kuralle — fresh runtime per call so each turn is a clean session (no history growth confound)
  const mkKuralle = (): Reasoner => {
    const rt = createRuntime({
      agents: [defineAgent({ id: "u", model: openai(MODEL), instructions: SYSTEM })],
      defaultAgentId: "u",
      sessionStore: new MemoryStore(),
    });
    return fromKuralleRuntime(rt as unknown as KuralleRuntimeLike, { sessionId: `bench-${Math.random()}` });
  };
  await bench("kuralle", mkKuralle);

  // Kuralle WITH working memory (what the smoke used) — quantifies the wm prompt cost
  const mkKuralleWm = (): Reasoner => {
    const rt = createRuntime({
      agents: [defineAgent({ id: "u", model: openai(MODEL), instructions: SYSTEM, memory: { workingMemory: { autoLoad: [{ scope: "user", key: "USER" }] } } })],
      defaultAgentId: "u",
      sessionStore: new MemoryStore(),
    });
    return fromKuralleRuntime(rt as unknown as KuralleRuntimeLike, { sessionId: `bench-${Math.random()}`, userId: "bench-user" });
  };
  await bench("kuralle+wm", mkKuralleWm);

  console.log("\n--- Kuralle internal phase trace (single turn) ---");
  const traceRt = createRuntime({
    agents: [defineAgent({ id: "u", model: openai(MODEL), instructions: SYSTEM })],
    defaultAgentId: "u",
    sessionStore: new MemoryStore(),
  });
  await kuralleTrace(traceRt as unknown as KuralleRuntimeLike);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
