// SPDX-License-Identifier: MIT
//
// Profile ONE turn properly, rather than inferring engine overhead by subtracting
// two numbers that were never measured over the same window.
//
// The mistake this exists to correct: the engine's `llmTtftMs` is
// finalTranscript -> first `llm.delta` ON THE BUS, while a raw fetch benchmark
// measures request-sent -> first content token. Those windows differ by however
// long the engine takes to decide to call the model, plus however long a delta
// takes to travel the bus. Subtracting one from the other measures nothing.
//
// Instruments used (node:perf_hooks):
//  - monitorEventLoopDelay(): ns-resolution histogram. If the loop is blocked
//    (audio framing, resampling, codecs), every await resumes late and that time
//    is indistinguishable from provider latency unless measured.
//  - eventLoopUtilization(): the share of wall time the loop was NOT idle.
//  - performance.mark/measure via PerformanceObserver, stamped on real bus packets.
//
//   tsx scripts/profile-turn.ts [--cpu-prof]
// For a CPU profile: node --cpu-prof --cpu-prof-dir=/tmp/prof $(which tsx) scripts/profile-turn.ts

// `eventLoopUtilization` is exposed on `performance`, not as a module-level export.
import { monitorEventLoopDelay, performance, PerformanceObserver } from "node:perf_hooks";

type Elu = { idle: number; active: number; utilization: number };
const eventLoopUtilization = (prev?: Elu): Elu =>
  (performance as unknown as { eventLoopUtilization: (p?: Elu) => Elu }).eventLoopUtilization(prev);

import { VoiceAgentSession, type VoicePlugin } from "@kuralle-syrinx/core";
import { ReasoningBridge, fromStreamText } from "@kuralle-syrinx/aisdk";
import { createOpenAI } from "@ai-sdk/openai";
import { DeepgramSTTPlugin } from "@kuralle-syrinx/deepgram";
import { ElevenLabsTTSPlugin } from "@kuralle-syrinx/elevenlabs";
import { OpenAICompatibleTTSPlugin } from "@kuralle-syrinx/openai-tts";
import { driveTurn } from "@kuralle-syrinx/cli/turn-runner";
import { ensureRepoRootDotenv, coerceGoogleGenAiKey } from "../src/run-one-turn.js";

const env = (k: string): string => process.env[k] ?? "";
const useOpenAiTts = process.argv.includes("--openai-tts");

interface Stamp { readonly label: string; readonly atMs: number }

function build(stamps: Stamp[]): VoiceAgentSession {
  const openai = createOpenAI({ apiKey: env("OPENAI_API_KEY") });
  const queueDelays: { kind: string; ms: number }[] = [];
  const session = new VoiceAgentSession({
    busConfig: { onQueueDelay: (kind, ms) => { if (ms >= 5) queueDelays.push({ kind, ms }); } },
    plugins: {
      stt: { api_key: env("DEEPGRAM_API_KEY"), model: "nova-3", sample_rate: 16000, emit_eos_on_final: true },
      bridge: {},
      tts: useOpenAiTts
        ? { api_key: env("OPENAI_API_KEY"), model: "gpt-4o-mini-tts", voice: "alloy" }
        : { api_key: env("ELEVENLABS_API_KEY") },
    },
    endpointingOwner: "provider_stt",
  });

  const mark = (label: string): void => {
    const atMs = performance.now();
    performance.mark(label);
    stamps.push({ label, atMs });
  };

  // Stamp the REAL bus boundaries. Each of these is a packet the engine already
  // publishes; nothing here changes engine behaviour.
  const first = new Set<string>();
  const once = (kind: string, label: string): void => {
    session.bus.on(kind as never, (() => {
      if (first.has(label)) return;
      first.add(label);
      mark(label);
    }) as never);
  };
  once("stt.result", "stt.result");
  once("eos.turn_complete", "eos.turn_complete");
  once("llm.delta", "llm.delta(first)");
  once("tts.text", "tts.text(first-dispatch)");
  once("tts.audio", "tts.audio(first-byte)");
  once("tts.end", "tts.end");
  (session as unknown as { __queueDelays: unknown }).__queueDelays = queueDelays;

  const plugins: Record<string, VoicePlugin> = {
    stt: new DeepgramSTTPlugin(),
    bridge: new ReasoningBridge(
      fromStreamText({ model: openai("gpt-4.1-mini"), system: "You are a terse voice assistant. One short sentence." }),
    ),
    tts: useOpenAiTts ? new OpenAICompatibleTTSPlugin() : new ElevenLabsTTSPlugin(),
  };
  for (const [n, p] of Object.entries(plugins)) session.registerPlugin(n, p);
  return session;
}

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  coerceGoogleGenAiKey();

  const measures: { name: string; duration: number }[] = [];
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) measures.push({ name: e.name, duration: Math.round(e.duration) });
  });
  obs.observe({ type: "measure" });

  // resolution 10ms: fine enough to catch a blocked loop, coarse enough not to
  // become the thing it is measuring.
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const eluStart = eventLoopUtilization();

  const stamps: Stamp[] = [];
  let sessionRef: VoiceAgentSession | undefined;
  const wall0 = performance.now();
  const r = await driveTurn({
    session: () => { sessionRef = build(stamps); return sessionRef; },
    inputWavPath: "../../runs/captured-fixture/captured.wav",
    sessionDir: `/tmp/profile-turn/${String(Date.now())}`,
    realtimePacing: true,
  });
  const wallMs = performance.now() - wall0;

  const elu = eventLoopUtilization(eluStart);
  loop.disable();

  // Consecutive gaps between real bus events — this is the decomposition, measured
  // rather than derived.
  const legs: { from: string; to: string; ms: number }[] = [];
  for (let i = 1; i < stamps.length; i += 1) {
    const a = stamps[i - 1];
    const b = stamps[i];
    if (a && b) legs.push({ from: a.label, to: b.label, ms: Math.round(b.atMs - a.atMs) });
  }

  console.log(JSON.stringify({
    transcript: r.finalTranscript,
    reply: r.agentReply,
    wallMs: Math.round(wallMs),
    busLegs: legs,
    engineMetrics: {
      speechEndToFinalTranscriptMs: r.metrics.speechEndToFinalTranscriptMs,
      llmTTFTMs: r.metrics.llmTTFTMs,
      ttsTTFBMs: r.metrics.ttsTTFBMs,
      speechEndToFirstAudioMs: r.metrics.speechEndToFirstAudioMs,
    },
    eventLoop: {
      // If p99 delay is small, the loop was NOT blocked, and latency attributed to
      // "the engine" is genuinely waiting on the network rather than on our own CPU.
      delayMs: {
        mean: Math.round(loop.mean / 1e6),
        p50: Math.round(loop.percentile(50) / 1e6),
        p99: Math.round(loop.percentile(99) / 1e6),
        max: Math.round(loop.max / 1e6),
      },
      utilization: Number(elu.utilization.toFixed(3)),
      activeMs: Math.round(elu.active),
      idleMs: Math.round(elu.idle),
    },
    measures,
    // Packets that waited >=5ms between push and dispatch. A handler awaiting long
    // I/O shows up here and nowhere else — packet timestamps are stamped at creation.
    queueDelays: ((): unknown => {
      const q = (sessionRef as unknown as { __queueDelays?: { kind: string; ms: number }[] }).__queueDelays ?? [];
      const byKind = new Map<string, number[]>();
      for (const d of q) byKind.set(d.kind, [...(byKind.get(d.kind) ?? []), d.ms]);
      return [...byKind.entries()]
        .map(([kind, xs]) => ({ kind, n: xs.length, maxMs: Math.max(...xs), totalMs: xs.reduce((a, b) => a + b, 0) }))
        .sort((a, b) => b.totalMs - a.totalMs)
        .slice(0, 8);
    })(),
  }, null, 2));
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
