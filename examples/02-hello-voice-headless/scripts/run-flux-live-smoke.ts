// SPDX-License-Identifier: MIT
//
// Live smoke: DeepgramFluxSTTPlugin against the real Flux v2 API, with the
// speculative ReasoningBridge riding its eager end-of-turn signals.
//
// Streams a 16 kHz mono PCM16 fixture in 80 ms chunks (Flux's recommended
// cadence) followed by trailing silence, and asserts:
//   1. TurnInfo flows: interim transcripts arrive, then eos.turn_complete.
//   2. Eager mode: with eager_eot_threshold set, eos.interim precedes
//      eos.turn_complete (or Flux skips straight to EndOfTurn — reported).
//   3. Speculative bridge: the turn is answered by a PROMOTED draft — no
//      generation starts after the confirmed endpoint. Multiple drafts are
//      expected when the speaker pauses mid-utterance (each eager endpoint
//      that gets TurnResumed costs one discarded draft — the documented
//      +50–70% eager-mode LLM-call overhead).
//
// Usage: pnpm -C examples/02-hello-voice-headless smoke:flux-live
// Requires DEEPGRAM_API_KEY in the repo .env. Costs a few seconds of Flux
// streaming (~$0.001) and zero LLM credits (the reasoner is a local fake).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { PipelineBusImpl, Route } from "@kuralle-syrinx/core";
import { DeepgramFluxSTTPlugin } from "@kuralle-syrinx/deepgram";
import { ReasoningBridge, fromStreamFactory } from "@kuralle-syrinx/aisdk";

loadEnv({ path: resolve(import.meta.dirname, "../../../.env") });

const apiKey = process.env["DEEPGRAM_API_KEY"];
if (!apiKey) {
  console.error("DEEPGRAM_API_KEY missing");
  process.exit(1);
}

const FIXTURE = resolve(import.meta.dirname, "../test/fixtures/university-cs-masters-deadline.wav");
const CHUNK_BYTES = 2560; // 80 ms @ 16 kHz PCM16
const CHUNK_MS = 80;

async function main(): Promise<void> {
  const startedAt = Date.now();
  const t = (): string => `+${String(Date.now() - startedAt).padStart(5)}ms`;

  const events: Array<{ atMs: number; kind: string; detail: string }> = [];
  const note = (kind: string, detail: string): void => {
    events.push({ atMs: Date.now() - startedAt, kind, detail });
    console.log(`${t()} ${kind.padEnd(18)} ${detail}`);
  };

  const bus = new PipelineBusImpl();
  const drain = bus.start();

  let generations = 0;
  let generationStartedAtMs = -1;
  const bridge = new ReasoningBridge(
    fromStreamFactory(async function* (request: { userText: string }) {
      generations += 1;
      generationStartedAtMs = Date.now() - startedAt;
      note("reasoner.start", `#${generations} for ${JSON.stringify(request.userText.slice(0, 60))}`);
      yield { type: "text-delta", id: "0", text: "The application deadline is May first." } as never;
      yield {
        type: "finish",
        finishReason: "stop",
        totalUsage: {},
        usage: {},
        response: {},
      } as never;
    }),
    { speculative: true },
  );
  await bridge.initialize(bus, { api_key: "fake", retry_max_attempts: 1, timeout_ms: 10_000 });

  bus.on("stt.interim", (pkt) => {
    note("stt.interim", JSON.stringify((pkt as { text: string }).text));
  });
  bus.on("eos.interim", (pkt) => {
    note("eos.interim", `EAGER ${JSON.stringify((pkt as { text: string }).text)}`);
  });
  bus.on("eos.retracted", () => {
    note("eos.retracted", "TurnResumed — draft discarded");
  });
  let finalText = "";
  let eosAtMs = -1;
  bus.on("eos.turn_complete", (pkt) => {
    finalText = (pkt as { text: string }).text;
    eosAtMs = Date.now() - startedAt;
    note("eos.turn_complete", JSON.stringify(finalText));
  });
  let llmDoneText = "";
  bus.on("llm.done", (pkt) => {
    llmDoneText = (pkt as { text: string }).text;
    note("llm.done", JSON.stringify(llmDoneText));
  });
  bus.on("stt.error", (pkt) => {
    note("stt.error", String((pkt as { cause: Error }).cause.message));
  });

  const flux = new DeepgramFluxSTTPlugin();
  await flux.initialize(bus, {
    api_key: apiKey,
    sample_rate: 16000,
    eot_threshold: 0.7,
    eager_eot_threshold: 0.4,
    keyterm: ["Syrinx"],
  });
  note("connected", "flux-general-en, eager_eot_threshold=0.4");

  const pcm = readFileSync(FIXTURE).subarray(44); // strip WAV header
  for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
    bus.push(Route.Main, {
      kind: "stt.audio",
      contextId: "flux-live-1",
      timestampMs: Date.now(),
      audio: new Uint8Array(pcm.subarray(offset, offset + CHUNK_BYTES)),
    });
    await new Promise((r) => setTimeout(r, CHUNK_MS));
  }
  note("audio", `fixture fully streamed (${Math.round(pcm.length / 32)}ms of speech)`);

  // Trailing silence so Flux can settle the end of turn.
  const silence = new Uint8Array(CHUNK_BYTES);
  const silenceDeadline = Date.now() + 6000;
  while (Date.now() < silenceDeadline && !llmDoneText) {
    bus.push(Route.Main, {
      kind: "stt.audio",
      contextId: "flux-live-1",
      timestampMs: Date.now(),
      audio: silence,
    });
    await new Promise((r) => setTimeout(r, CHUNK_MS));
  }

  await flux.close();
  await bridge.close();
  bus.stop();
  await drain;

  const eagers = events.filter((e) => e.kind === "eos.interim");
  const retractions = events.filter((e) => e.kind === "eos.retracted");
  const lastEager = eagers.at(-1);
  const failures: string[] = [];
  if (!finalText) failures.push("no eos.turn_complete received");
  if (!llmDoneText) failures.push("no llm.done — bridge never answered the turn");
  if (generations === 0) failures.push("no reasoner generation ran");
  // Promotion proof: the answering generation started at-or-before the confirmed
  // endpoint. A generation starting after eos means the draft failed to promote
  // and the bridge paid a fresh confirm-time call.
  if (eosAtMs >= 0 && generationStartedAtMs > eosAtMs) {
    failures.push(`a generation started ${generationStartedAtMs - eosAtMs}ms AFTER the endpoint — draft was not promoted`);
  }
  if (generations !== eagers.length) {
    failures.push(`drafts (${generations}) != eager endpoints (${eagers.length}) — a draft leaked or was missed`);
  }

  console.log("\n=== FLUX LIVE SMOKE SUMMARY ===");
  console.log(`final transcript : ${JSON.stringify(finalText)}`);
  console.log(`eager endpoints  : ${eagers.length} (${retractions.length} resumed → drafts discarded; last at ${lastEager?.atMs ?? "-"}ms, EndOfTurn at ${eosAtMs}ms)`);
  console.log(`drafts run       : ${generations} (${retractions.length} discarded, 1 promoted — eager-mode overhead is the documented cost)`);
  console.log(`verdict          : ${failures.length === 0 ? "PASS" : `FAIL — ${failures.join("; ")}`}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
