// SPDX-License-Identifier: MIT
//
// Live A/B: speculative generation OFF vs ON, everything else identical.
//
// Both arms stream the same 16 kHz fixture into live Deepgram Flux
// (eager_eot_threshold 0.4 in BOTH — the eager signals exist either way; only
// the bridge's `speculative` option changes) with a live gpt-4o-mini reasoner,
// so the LLM's time-to-first-token is real.
//
// Headline metric per arm: confirmed endpoint (eos.turn_complete) → first
// llm.delta on the bus — the moment the agent has words to say. OFF pays the
// full LLM TTFT after the endpoint; ON should have paid it during the
// endpoint-confirmation window (a promoted draft flushes at ~0ms).
//
// Usage: pnpm -C examples/02-hello-voice-headless smoke:flux-speculative-ab
// Requires DEEPGRAM_API_KEY + OPENAI_API_KEY. Cost per arm: ~5s Flux + one or
// a few one-sentence gpt-4o-mini completions.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { streamText } from "ai";
import { openai } from "@ai-sdk/openai";
import { PipelineBusImpl, Route } from "@kuralle-syrinx/core";
import { DeepgramFluxSTTPlugin } from "@kuralle-syrinx/deepgram";
import { ReasoningBridge, fromStreamFactory } from "@kuralle-syrinx/aisdk";

loadEnv({ path: resolve(import.meta.dirname, "../../../.env") });

for (const key of ["DEEPGRAM_API_KEY", "OPENAI_API_KEY"]) {
  if (!process.env[key]) {
    console.error(`${key} missing`);
    process.exit(1);
  }
}

// Short, pause-free utterance: avoids Flux splitting the turn mid-pause, which
// would make the two arms transcribe different turns and corrupt the A/B.
const FIXTURE = resolve(import.meta.dirname, "../test/fixtures/what-did-i-just-ask.wav");
const CHUNK_BYTES = 2560; // 80ms @ 16kHz PCM16
const CHUNK_MS = 80;

interface ArmResult {
  speculative: boolean;
  finalText: string;
  answer: string;
  llmCalls: number;
  eagerCount: number;
  retractCount: number;
  eosAtMs: number;
  firstDeltaAtMs: number;
  doneAtMs: number;
}

async function runArm(speculative: boolean): Promise<ArmResult> {
  const startedAt = Date.now();
  const now = (): number => Date.now() - startedAt;

  const bus = new PipelineBusImpl();
  const drain = bus.start();

  let llmCalls = 0;
  const bridge = new ReasoningBridge(
    fromStreamFactory(async function* (request: { userText: string; signal: AbortSignal }) {
      llmCalls += 1;
      const result = streamText({
        model: openai("gpt-4o-mini"),
        system: "You are a university support agent. Answer in one short sentence.",
        prompt: request.userText,
        abortSignal: request.signal,
      });
      yield* result.fullStream as AsyncIterable<never>;
    }),
    speculative ? { speculative: true } : {},
  );
  await bridge.initialize(bus, { api_key: "unused", retry_max_attempts: 1, timeout_ms: 20_000 });

  const result: ArmResult = {
    speculative,
    finalText: "",
    answer: "",
    llmCalls: 0,
    eagerCount: 0,
    retractCount: 0,
    eosAtMs: -1,
    firstDeltaAtMs: -1,
    doneAtMs: -1,
  };
  bus.on("eos.interim", () => {
    result.eagerCount += 1;
  });
  bus.on("eos.retracted", () => {
    result.retractCount += 1;
  });
  bus.on("eos.turn_complete", (pkt) => {
    result.finalText = (pkt as { text: string }).text;
    // Track the MOST RECENT endpoint: if Flux splits the utterance, the answer
    // correlates with the last endpoint before the first token, not the first.
    if (result.firstDeltaAtMs < 0) result.eosAtMs = now();
  });
  bus.on("llm.delta", () => {
    if (result.firstDeltaAtMs < 0) result.firstDeltaAtMs = now();
  });
  bus.on("llm.done", (pkt) => {
    result.answer = (pkt as { text: string }).text;
    if (result.doneAtMs < 0) result.doneAtMs = now();
  });

  const flux = new DeepgramFluxSTTPlugin();
  await flux.initialize(bus, {
    api_key: process.env["DEEPGRAM_API_KEY"],
    sample_rate: 16000,
    eot_threshold: 0.7,
    eager_eot_threshold: 0.4,
  });

  const pcm = readFileSync(FIXTURE).subarray(44);
  for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
    bus.push(Route.Main, {
      kind: "stt.audio",
      contextId: `ab-${speculative ? "on" : "off"}`,
      timestampMs: Date.now(),
      audio: new Uint8Array(pcm.subarray(offset, offset + CHUNK_BYTES)),
    });
    await new Promise((r) => setTimeout(r, CHUNK_MS));
  }
  const silence = new Uint8Array(CHUNK_BYTES);
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline && result.doneAtMs < 0) {
    bus.push(Route.Main, {
      kind: "stt.audio",
      contextId: `ab-${speculative ? "on" : "off"}`,
      timestampMs: Date.now(),
      audio: silence,
    });
    await new Promise((r) => setTimeout(r, CHUNK_MS));
  }

  await flux.close();
  await bridge.close();
  bus.stop();
  await drain;
  result.llmCalls = llmCalls;
  return result;
}

function report(r: ArmResult): void {
  const eosToDelta = r.firstDeltaAtMs >= 0 && r.eosAtMs >= 0 ? r.firstDeltaAtMs - r.eosAtMs : NaN;
  console.log(`\n--- speculative: ${r.speculative ? "ON " : "OFF"} ---`);
  console.log(`transcript              : ${JSON.stringify(r.finalText)}`);
  console.log(`answer                  : ${JSON.stringify(r.answer.slice(0, 80))}`);
  console.log(`llm calls               : ${r.llmCalls} (eager endpoints ${r.eagerCount}, resumed ${r.retractCount})`);
  console.log(`endpoint → first token  : ${eosToDelta}ms   <-- headline`);
  console.log(`endpoint → answer done  : ${r.doneAtMs - r.eosAtMs}ms`);
}

async function main(): Promise<void> {
  // Warm the OpenAI connection so arm order doesn't confound the comparison
  // (the process's first call pays TLS/connection setup, not just TTFT).
  process.stdout.write("Warming LLM connection... ");
  const warmStart = Date.now();
  const warm = streamText({ model: openai("gpt-4o-mini"), prompt: "Say ok." });
  for await (const part of warm.fullStream) {
    if (part.type === "text-delta") break;
  }
  const coldTtft = Date.now() - warmStart;
  const warm2Start = Date.now();
  const warm2 = streamText({ model: openai("gpt-4o-mini"), prompt: "Say ok." });
  for await (const part of warm2.fullStream) {
    if (part.type === "text-delta") break;
  }
  console.log(`done. Bare streamText TTFT: cold ${coldTtft}ms, warm ${Date.now() - warm2Start}ms.`);

  console.log("Arm 1/2: speculative OFF (live Flux + live gpt-4o-mini)");
  const off = await runArm(false);
  report(off);
  console.log("\nArm 2/2: speculative ON");
  const on = await runArm(true);
  report(on);

  const offGap = off.firstDeltaAtMs - off.eosAtMs;
  const onGap = on.firstDeltaAtMs - on.eosAtMs;
  console.log("\n=== A/B SUMMARY ===");
  console.log(`endpoint → first token: OFF ${offGap}ms vs ON ${onGap}ms  (saved ${offGap - onGap}ms)`);
  console.log(`llm-call cost: OFF ${off.llmCalls} vs ON ${on.llmCalls}`);
  const ok = off.finalText.length > 0 && on.finalText.length > 0 && off.doneAtMs > 0 && on.doneAtMs > 0;
  console.log(`verdict: ${ok ? "PASS (both arms answered)" : "FAIL"}`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
