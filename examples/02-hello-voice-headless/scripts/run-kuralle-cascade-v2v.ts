// SPDX-License-Identifier: MIT
//
// Our own cascaded voice-to-voice through the REAL syrinx pipeline (Deepgram STT →
// LLM → Cartesia TTS), with the kuralle agent as the brain (vs an AI SDK baseline on
// the IDENTICAL STT/TTS). Uses the headless runOneTurn harness, which injects a real
// speech WAV and reports per-stage metrics. NOT LiveKit — this is syrinx's cascade.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);
const { WaveFile } = require("wavefile") as typeof import("wavefile");

import { createOpenAI } from "@ai-sdk/openai";
import { stepCountIs } from "ai";
import type { VoicePlugin, PluginConfig } from "@kuralle-syrinx/core";
import { ReasoningBridge, fromStreamText } from "@kuralle-syrinx/aisdk";
import { fromKuralleRuntime, type KuralleRuntimeLike } from "@kuralle-syrinx/kuralle";
import { DeepgramSTTPlugin } from "@kuralle-syrinx/deepgram";
import { CartesiaTTSPlugin } from "@kuralle-syrinx/cartesia";
import { SileroVADPlugin } from "@kuralle-syrinx/silero-vad";

import { runOneTurn, ensureRepoRootDotenv, DEFAULT_MODEL, type PerTurnMetrics } from "../src/run-one-turn.js";
import { createFullUniversityRuntime } from "../src/university-agent-full.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, "..", "test", "fixtures", "university-support-add-drop.wav");
const REPS = 2;
const VOICE_ID = "694f9389-aac1-45b6-b726-9d9369183238";

function pluginConfig(): Record<string, PluginConfig> {
  return {
    stt: { api_key: process.env["DEEPGRAM_API_KEY"], sample_rate: 16000, endpointing: 600, model: "nova-3", language: "en-US" },
    vad: { threshold: 0.01 },
    bridge: {},
    tts: { api_key: process.env["CARTESIA_API_KEY"], voice_id: VOICE_ID, model_id: "sonic-3", sample_rate: 16000, language: "en" },
  };
}

function commonPlugins(bridge: VoicePlugin): Record<string, VoicePlugin> {
  return { stt: new DeepgramSTTPlugin(), vad: new SileroVADPlugin(), bridge, tts: new CartesiaTTSPlugin() };
}

// Load the fixture + append 1.5s trailing silence so Deepgram's endpointing (600ms)
// finalizes NATURALLY instead of the harness force-finalizing at 3500ms.
function paddedSamples(): Int16Array {
  const wav = new WaveFile(readFileSync(FIXTURE));
  wav.toSampleRate(16000);
  wav.toBitDepth("16");
  const raw = wav.getSamples(false, Int16Array) as unknown as Int16Array | Int16Array[];
  const mono = Array.isArray(raw) ? raw[0]! : raw;
  const silence = new Int16Array(16000 * 1.5);
  const out = new Int16Array(mono.length + silence.length);
  out.set(mono, 0);
  out.set(silence, mono.length);
  return out;
}
const SAMPLES = paddedSamples();

async function runTurn(label: string, makeBridge: () => VoicePlugin): Promise<PerTurnMetrics> {
  const sessionDir = await mkdtemp(join(tmpdir(), `cascade-${label}-`));
  const res = await runOneTurn({
    inputWavPath: FIXTURE,
    sessionDir,
    syntheticMono16kSamples: SAMPLES,
    sessionOverrides: { plugins: commonPlugins(makeBridge()), pluginConfig: pluginConfig() },
  });
  return res.metrics;
}

function avg(xs: number[]): number { return Math.round(xs.reduce((a, b) => a + b, 0) / xs.length); }

async function measure(label: string, makeBridge: () => VoicePlugin): Promise<Record<string, number>> {
  const runs: PerTurnMetrics[] = [];
  for (let i = 0; i < REPS; i++) runs.push(await runTurn(label, makeBridge));
  const m = (k: keyof PerTurnMetrics) => avg(runs.map((r) => Number(r[k])));
  const out = {
    inputAudioMs: m("inputAudioMs"),
    stt_finalize: m("speechEndToFinalTranscriptMs"),
    llm_ttft: m("llmTTFTMs"),
    tts_ttfb: m("ttsTTFBMs"),
    speechEnd_to_firstAudio: m("speechEndToFirstAudioMs"),
    e2e: m("e2eLatencyMs"),
  };
  console.log(`\n### ${label} (mean of ${REPS})`);
  console.log(`  STT finalize (speechEnd→final):  ${out.stt_finalize} ms`);
  console.log(`  LLM TTFT (final→first token):    ${out.llm_ttft} ms`);
  console.log(`  TTS TTFB (token→first audio):    ${out.tts_ttfb} ms`);
  console.log(`  V2V (speechEnd→first audio out): ${out.speechEnd_to_firstAudio} ms`);
  console.log(`  e2e: ${out.e2e} ms  | input audio: ${out.inputAudioMs} ms`);
  return out;
}

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  for (const k of ["OPENAI_API_KEY", "DEEPGRAM_API_KEY", "CARTESIA_API_KEY"]) {
    if (!process.env[k]?.trim()) throw new Error(`${k} required`);
  }
  console.log(`Syrinx cascaded V2V — Deepgram nova-3 STT + LLM + Cartesia sonic-3 TTS, fixture=university-support-add-drop.wav`);

  const openai = createOpenAI({ apiKey: process.env["OPENAI_API_KEY"]! });
  const aisdk = await measure("AI SDK brain (baseline)", () =>
    new ReasoningBridge(fromStreamText({
      model: openai(DEFAULT_MODEL), system: "You are a helpful university support assistant. Answer in one or two short sentences.",
      temperature: 0.4, maxOutputTokens: 256, maxRetries: 0, timeout: 30_000, stopWhen: stepCountIs(1),
    })),
  );

  const { runtime } = await createFullUniversityRuntime();
  const kuralle = await measure("kuralle-agent brain (RAG+flows+skills)", () =>
    new ReasoningBridge(fromKuralleRuntime(runtime as unknown as KuralleRuntimeLike, { sessionId: `cascade-${Math.random()}`, userId: "cascade" })),
  );

  console.log(`\n=== Syrinx cascaded V2V — stage breakdown (ms) ===`);
  console.log(`stage                         AI SDK    kuralle-agent`);
  const rows: Array<[string, keyof typeof aisdk]> = [
    ["STT finalize", "stt_finalize"], ["LLM TTFT", "llm_ttft"], ["TTS TTFB", "tts_ttfb"],
    ["V2V (speechEnd→1st audio)", "speechEnd_to_firstAudio"],
  ];
  for (const [name, key] of rows) {
    console.log(`${name.padEnd(28)}  ${String(aisdk[key]).padStart(6)}    ${String(kuralle[key]).padStart(6)}`);
  }
  console.log(`\nSTT+TTS are brain-independent (~${aisdk.stt_finalize + aisdk.tts_ttfb}ms pinned); the LLM term is where AI SDK vs kuralle diverges.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
