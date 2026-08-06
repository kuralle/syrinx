// SPDX-License-Identifier: MIT
//
// FALSIFICATION SPIKE (Phase 0, assumption A1).
//
// Claim under test: "the existing ObservabilityObserver cannot decompose a turn —
// v2v_ms and thinking_ms are a black box, so Phase 0 must add stt_final_ms,
// llm_ttft_ms, tool_ms and tts_ttfb_ms."
//
// Method: drive the REAL ObservabilityObserver over a REAL PipelineBusImpl with a
// real InMemoryMetricsExporter through a realistic cascade turn that contains an
// LLM call and two tool round-trips, then ask what can actually be recovered from
// the exported histograms alone. Stage durations are scaled down 10x so the spike
// runs in ~1s; only the RELATIONSHIPS between metrics matter.
//
// Run: npx tsx scripts/spike-observability-decomposition.ts

import {
  ObservabilityObserver,
  InMemoryMetricsExporter,
  PipelineBusImpl,
  Route,
  reconstructTurnTimeline,
  type TurnBoundaryEventPacket,
} from "@kuralle-syrinx/core";

const CTX = "spike-turn-1";
const SCALE = 10; // real-world ms / SCALE

/** Ground truth for one realistic tool-calling cascade turn (real-world ms). */
const GROUND_TRUTH = {
  speechDuration: 2000, // user talks
  endpoint: 1400, // vad.speech_ended -> eos.turn_complete (STT settle + endpointer)
  llmTtft: 800, // eos -> first llm.delta
  tool1: 1200, // first tool round-trip
  tool2: 1100, // second tool round-trip
  llmFinal: 400, // post-tool generation to first sentence
  ttsTtfb: 700, // tts.text -> first tts.audio
  agentSpeech: 2000, // first tts.audio -> tts.end
} as const;

const sleep = (realWorldMs: number): Promise<void> =>
  new Promise((r) => setTimeout(r, realWorldMs / SCALE));

async function main(): Promise<void> {
  const bus = new PipelineBusImpl();
  const exporter = new InMemoryMetricsExporter();
  const boundaries: TurnBoundaryEventPacket[] = [];

  bus.on("obs.turn_boundary", (pkt) => {
    boundaries.push(pkt as TurnBoundaryEventPacket);
  });

  const observer = new ObservabilityObserver({
    bus,
    exporter,
    sessionId: "spike-session",
    dims: { provider: "deepgram", model: "gpt-4.1-mini", region: "local" },
    getContextId: () => CTX,
  });
  observer.wire();

  // The bus only dispatches while its drain loop runs.
  const draining = bus.start();

  const now = (): number => Date.now();

  // --- the turn, as the pipeline actually emits it -------------------------
  bus.push(Route.Main, { kind: "vad.speech_started", contextId: CTX, timestampMs: now(), confidence: 0.9 });
  await sleep(GROUND_TRUTH.speechDuration);

  bus.push(Route.Main, { kind: "vad.speech_ended", contextId: CTX, timestampMs: now() });
  await sleep(GROUND_TRUTH.endpoint);

  bus.push(Route.Main, {
    kind: "eos.turn_complete",
    contextId: CTX,
    timestampMs: now(),
    text: "what's the application deadline for the cs masters?",
    transcripts: [],
  });

  // Everything below here is INVISIBLE to the observer: it subscribes to
  // vad.*, eos.turn_complete, tts.audio, tts.end, interrupt.detected — and to
  // nothing else. No llm.delta, no stt.result, no tool event.
  await sleep(GROUND_TRUTH.llmTtft); //   LLM first token
  await sleep(GROUND_TRUTH.tool1); //     tool round-trip 1
  await sleep(GROUND_TRUTH.tool2); //     tool round-trip 2
  await sleep(GROUND_TRUTH.llmFinal); //  post-tool generation
  await sleep(GROUND_TRUTH.ttsTtfb); //   TTS time-to-first-byte

  bus.push(Route.Media, {
    kind: "tts.audio",
    contextId: CTX,
    timestampMs: now(),
    audio: new Uint8Array(320),
    sampleRateHz: 16_000,
  });
  await sleep(GROUND_TRUTH.agentSpeech);

  bus.push(Route.Main, { kind: "tts.end", contextId: CTX, timestampMs: now() });
  await sleep(500);
  await bus.stop();
  await draining;

  // --- what can we actually recover? --------------------------------------
  const h = (name: string): number | null => {
    const found = exporter.histograms.find((x) => x.name === name);
    return found ? Math.round(found.valueMs * SCALE) : null;
  };

  const v2v = h("v2v_ms");
  const thinking = h("thinking_ms");
  const agentSpeech = h("agent_speech_ms");

  console.log("=== histograms actually exported ===");
  console.log(
    exporter.histograms.map((x) => `  ${x.name} = ${Math.round(x.valueMs * SCALE)}ms`).join("\n") ||
      "  (none)",
  );
  console.log(`\n  tags on v2v_ms: ${JSON.stringify(exporter.histograms[0]?.tags ?? {})}`);

  console.log("\n=== turn boundaries emitted ===");
  const timeline = reconstructTurnTimeline(boundaries, "spike-session");
  for (const s of timeline) {
    console.log(`  ${s.boundary.padEnd(24)} +${Math.round(s.sincePrevMs * SCALE)}ms`);
  }

  const gt = GROUND_TRUTH;
  const trueThinking = gt.llmTtft + gt.tool1 + gt.tool2 + gt.llmFinal + gt.ttsTtfb;

  console.log("\n=== can each stage be recovered from the metrics alone? ===");
  const derivedEndpoint = v2v !== null && thinking !== null ? v2v - thinking : null;
  const row = (stage: string, truth: number, derived: number | null, how: string): void => {
    const ok = derived !== null && Math.abs(derived - truth) < truth * 0.25;
    console.log(
      `  ${ok ? "RECOVERABLE  " : "OPAQUE       "} ${stage.padEnd(14)} truth=${String(truth).padStart(5)}ms  ` +
        `derived=${derived === null ? "  n/a" : String(derived).padStart(5) + "ms"}  ${how}`,
    );
  };

  row("endpoint", gt.endpoint, derivedEndpoint, "v2v_ms - thinking_ms");
  row("llm_ttft", gt.llmTtft, null, "no llm.delta subscription");
  row("tool_total", gt.tool1 + gt.tool2, null, "no tool event at all");
  row("tts_ttfb", gt.ttsTtfb, null, "no tts.text subscription");
  row("agent_speech", gt.agentSpeech, agentSpeech, "agent_speech_ms");

  console.log("\n=== verdict ===");
  console.log(`  v2v_ms      = ${String(v2v)}ms   (truth ${gt.endpoint + trueThinking})`);
  console.log(`  thinking_ms = ${String(thinking)}ms   (truth ${trueThinking})`);
  console.log(
    `  thinking_ms is ONE bucket containing: llm_ttft ${gt.llmTtft} + tool1 ${gt.tool1} + ` +
      `tool2 ${gt.tool2} + llm_final ${gt.llmFinal} + tts_ttfb ${gt.ttsTtfb}`,
  );
  const opaqueShare = Math.round((trueThinking / (gt.endpoint + trueThinking)) * 100);
  console.log(`  => ${opaqueShare}% of v2v is inside the single opaque thinking_ms bucket.`);

  observer.dispose();
}

void main();
