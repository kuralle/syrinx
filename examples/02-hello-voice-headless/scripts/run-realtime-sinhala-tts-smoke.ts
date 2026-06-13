// SPDX-License-Identifier: MIT
//
// EXPLORATORY PROBE (not a gate): the "realtime brain + language-specific TTS" thesis.
//
// Dual-model question: realtime s2s models understand many languages well, but voice
// under-resourced languages (e.g. Sinhala) poorly. So — use gpt-realtime as the
// multilingual understanding/reasoning front (TEXT out), and voice the answer with a
// native TTS (epsilon, Sinhala). This script gathers the evidence BEFORE we design the
// `outputMode` + language-routing change to RealtimeBridge. It touches NO production code.
//
// Phase 1: English add/drop question (fixture) → gpt-realtime, system-prompted to reply in
//          Sinhala script. Capture the assistant transcript (the text we'd feed TTS) AND the
//          model's OWN Sinhala audio (saved for an A/B listen — this is the "bad" native audio).
// Phase 2: feed that Sinhala text to EpsilonTTSPlugin; measure warm TTFA + save its audio.
// Analysis: Sinhala-script ratio + Latin-char (code-switch) detection.
//
// Needs OPENAI_API_KEY in repo-root .env. Epsilon endpoint/key fall back to the documented
// alpha (overridable via EPSILON_BASE_URL / EPSILON_API_KEY).

import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PipelineBusImpl,
  Route,
  type TextToSpeechAudioPacket,
  type TextToSpeechEndPacket,
} from "@kuralle-syrinx/core";
import { EpsilonTTSPlugin } from "@kuralle-syrinx/epsilon";
import { fromOpenAIRealtime, type RealtimeEvent } from "@kuralle-syrinx/realtime";
import { createNodeWsSocket } from "@kuralle-syrinx/ws/node";

import { ensureRepoRootDotenv, readPcm16Mono16kWav } from "../src/run-one-turn.js";

const require = createRequire(import.meta.url);
const { WaveFile } = require("wavefile") as typeof import("wavefile");

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const FIXTURE_PATH = join(PKG_ROOT, "test", "fixtures", "university-support-add-drop.wav");
const OUTPUT_DIR = join(PKG_ROOT, "test", "performance", "runs", "realtime-sinhala-tts-smoke");

const ENGINE_SAMPLE_RATE_HZ = 16_000;
// OpenAI realtime requires input format rate >= 24000, so the engine's 16k fixture is
// resampled to 24k before it reaches the provider (the same 16k→24k input leg the bridge runs).
const REALTIME_RATE_HZ = 24_000;
const EPSILON_SAMPLE_RATE_HZ = 24_000;
const FRAME_SAMPLES = 480; // 20ms @ 24kHz

const SINHALA_SYSTEM_PROMPT = [
  "You are a helpful university student-support agent.",
  "The caller speaks English. ALWAYS respond in natural, conversational Sinhala.",
  "Write your reply ONLY in Sinhala (සිංහල) script — never romanize.",
  "Keep replies to one or two short sentences.",
].join(" ");

function pcmToBytes(samples: Readonly<Int16Array>): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}

// Linear-interp resample (mirrors RealtimeBridge's input leg). Fixture is 16k; provider wants 24k.
function resamplePcm16(samples: Int16Array, fromHz: number, toHz: number): Int16Array {
  if (fromHz === toHz) return samples;
  const outLength = Math.max(1, Math.round((samples.length * toHz) / fromHz));
  const out = new Int16Array(outLength);
  const ratio = fromHz / toHz;
  for (let i = 0; i < out.length; i += 1) {
    const src = i * ratio;
    const lo = Math.floor(src);
    const hi = Math.min(samples.length - 1, lo + 1);
    const frac = src - lo;
    out[i] = Math.round(samples[lo]! * (1 - frac) + samples[hi]! * frac);
  }
  return out;
}

function sliceFramePcm(samples: Readonly<Int16Array>, offset: number): Int16Array {
  const end = Math.min(offset + FRAME_SAMPLES, samples.length);
  const frame = new Int16Array(FRAME_SAMPLES);
  if (end > offset) frame.set(samples.subarray(offset, end));
  return frame;
}

function mergeBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

async function writePcm16Wav(
  path: string,
  chunks: readonly Uint8Array[],
  sampleRateHz: number,
): Promise<number> {
  const bytes = mergeBytes(chunks);
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const wav = new WaveFile();
  wav.fromScratch(1, sampleRateHz, "16", samples);
  await writeFile(path, Buffer.from(wav.toBuffer()));
  return bytes.byteLength;
}

function peakMagnitude(chunks: readonly Uint8Array[]): number {
  const bytes = mergeBytes(chunks);
  if (bytes.byteLength < 2) return 0;
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  let peak = 0;
  for (const sample of samples) {
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
  }
  return peak;
}

interface ScriptStats {
  sinhalaChars: number;
  latinChars: number;
  digits: number;
  sinhalaRatioOfLetters: number;
  latinRuns: string[];
}

function analyzeScript(text: string): ScriptStats {
  let sinhala = 0;
  let latin = 0;
  let digits = 0;
  let currentRun = "";
  const latinRuns: string[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const isLatin = (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a);
    if (cp >= 0x0d80 && cp <= 0x0dff) sinhala += 1;
    else if (isLatin) latin += 1;
    else if (cp >= 0x30 && cp <= 0x39) digits += 1;
    // Track contiguous Latin runs (= code-switched English tokens) for the TTS-normalization question.
    if (isLatin) currentRun += ch;
    else if (currentRun) {
      latinRuns.push(currentRun);
      currentRun = "";
    }
  }
  if (currentRun) latinRuns.push(currentRun);
  const letters = sinhala + latin;
  return {
    sinhalaChars: sinhala,
    latinChars: latin,
    digits,
    sinhalaRatioOfLetters: letters > 0 ? Number((sinhala / letters).toFixed(3)) : 0,
    latinRuns,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Phase1Result {
  sinhalaText: string;
  realtimeAudioChunks: Uint8Array[];
  realtimeTtfaMs: number | null;
}

// Phase 1 — drive gpt-realtime directly via the adapter (no bridge): English audio in,
// Sinhala transcript + native Sinhala audio out.
async function runRealtimePhase(apiKey: string, pcm: Int16Array): Promise<Phase1Result> {
  const adapter = fromOpenAIRealtime({
    apiKey,
    socketFactory: createNodeWsSocket,
    // input/output both 24k (provider minimum); fixture resampled 16k→24k below.
    instructions: SINHALA_SYSTEM_PROMPT,
    turnDetection: { type: "server_vad", silence_duration_ms: 500 },
  });
  const pcm24 = resamplePcm16(pcm, ENGINE_SAMPLE_RATE_HZ, REALTIME_RATE_HZ);

  const abort = new AbortController();
  const realtimeAudioChunks: Uint8Array[] = [];
  let sinhalaText = "";
  let responseStartedAt: number | null = null;
  let realtimeTtfaMs: number | null = null;
  let responseDone = false;

  await adapter.open(abort.signal);

  const pump = (async () => {
    for await (const ev of adapter.events as AsyncIterable<RealtimeEvent>) {
      switch (ev.type) {
        case "response_started":
          responseStartedAt = Date.now();
          break;
        case "audio":
          if (realtimeTtfaMs === null && responseStartedAt !== null) {
            realtimeTtfaMs = Date.now() - responseStartedAt;
          }
          realtimeAudioChunks.push(ev.pcm16);
          break;
        case "transcript":
          if (ev.role === "assistant" && ev.final && ev.text.trim()) {
            sinhalaText = sinhalaText ? `${sinhalaText} ${ev.text.trim()}` : ev.text.trim();
          }
          break;
        case "response_done":
          responseDone = true;
          return;
        case "error":
          if (!ev.recoverable) throw ev.cause;
          console.error("[realtime] recoverable:", ev.cause.message);
          break;
        default:
          break;
      }
    }
  })();

  // Feed the English fixture (resampled to 24k), then trailing silence so server_vad endpoints the turn.
  let offset = 0;
  while (offset < pcm24.length) {
    adapter.sendAudio(pcmToBytes(sliceFramePcm(pcm24, offset)));
    offset += FRAME_SAMPLES;
    await sleep(20);
  }
  for (let pad = 0; pad < 100 && !responseDone; pad += 1) {
    adapter.sendAudio(pcmToBytes(new Int16Array(FRAME_SAMPLES)));
    await sleep(20);
  }

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("realtime response timeout (60s)")), 60_000),
  );
  await Promise.race([pump, timeout]);

  abort.abort();
  await adapter.close();

  if (!sinhalaText) throw new Error("gpt-realtime produced no assistant transcript");
  return { sinhalaText, realtimeAudioChunks, realtimeTtfaMs };
}

interface Phase2Result {
  epsilonTtfaMs: number | null;
  epsilonAudioChunks: Uint8Array[];
  epsilonSource: string;
  error: string | null;
}

// Phase 2 — voice the Sinhala text with epsilon; measure warm TTFA precisely.
// Soft-fails (returns an error string) so the phase-1 evidence is always reported even when
// the epsilon endpoint is down — this is an exploratory probe, not a pass/fail gate.
async function runEpsilonPhase(sinhalaText: string): Promise<Phase2Result> {
  const baseUrl = process.env["EPSILON_BASE_URL"]?.trim();
  const apiKey = process.env["EPSILON_API_KEY"]?.trim();
  const epsilonSource = "env";
  if (!baseUrl || !apiKey) {
    return {
      epsilonTtfaMs: null,
      epsilonAudioChunks: [],
      epsilonSource,
      error: "EPSILON_BASE_URL/EPSILON_API_KEY not set — skipping epsilon A/B leg",
    };
  }

  const epsilonAudioChunks: Uint8Array[] = [];
  let firstAudioAt: number | null = null;
  let ended = false;
  let ttsError: string | null = null;
  const contextId = "sinhala-tts-probe";

  const bus = new PipelineBusImpl();
  const started = bus.start();
  const plugin = new EpsilonTTSPlugin(createNodeWsSocket);

  bus.on("tts.audio", (pkt) => {
    const audioPkt = pkt as TextToSpeechAudioPacket;
    if (audioPkt.contextId !== contextId) return;
    if (firstAudioAt === null) firstAudioAt = Date.now();
    epsilonAudioChunks.push(audioPkt.audio);
  });
  bus.on("tts.end", (pkt) => {
    if ((pkt as TextToSpeechEndPacket).contextId === contextId) ended = true;
  });
  bus.on("tts.error", (pkt) => {
    const cause = (pkt as { cause?: Error }).cause;
    if (!ttsError) ttsError = cause?.message ?? "epsilon tts.error";
  });

  const sentAt = Date.now();
  try {
    await plugin.initialize(bus, {
      api_key: apiKey,
      base_url: baseUrl,
      voice: "sinhala",
      sample_rate: EPSILON_SAMPLE_RATE_HZ,
    });

    bus.push(Route.Main, { kind: "tts.text", contextId, timestampMs: sentAt, text: sinhalaText });
    bus.push(Route.Main, { kind: "tts.done", contextId, timestampMs: Date.now(), text: sinhalaText });

    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && !ended && !ttsError) {
      await sleep(200);
    }
    if (!ended && !ttsError) ttsError = "epsilon tts.end timeout (120s)";
  } catch (err) {
    ttsError = err instanceof Error ? err.message : String(err);
  } finally {
    await plugin.close().catch(() => {});
    bus.stop();
    await started;
  }

  return {
    epsilonTtfaMs: firstAudioAt === null ? null : firstAudioAt - sentAt,
    epsilonAudioChunks,
    epsilonSource,
    error: ttsError,
  };
}

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  const apiKey = process.env["OPENAI_API_KEY"]?.trim();
  if (!apiKey) throw new Error("missing OPENAI_API_KEY in repo-root .env");

  await mkdir(OUTPUT_DIR, { recursive: true });
  const pcm = readPcm16Mono16kWav(FIXTURE_PATH);

  const phase1 = await runRealtimePhase(apiKey, pcm);
  const scriptStats = analyzeScript(phase1.sinhalaText);

  const phase2 = await runEpsilonPhase(phase1.sinhalaText);

  const realtimeWavPath = join(OUTPUT_DIR, "realtime-native-sinhala.wav");
  const realtimeBytes = await writePcm16Wav(
    realtimeWavPath,
    phase1.realtimeAudioChunks,
    REALTIME_RATE_HZ,
  );

  const epsilonOk = phase2.epsilonAudioChunks.length > 0;
  const epsilonWavPath = join(OUTPUT_DIR, "epsilon-sinhala.wav");
  const epsilonBytes = epsilonOk
    ? await writePcm16Wav(epsilonWavPath, phase2.epsilonAudioChunks, EPSILON_SAMPLE_RATE_HZ)
    : 0;

  const report = {
    ok: true,
    thesis: "realtime brain (text out) + native TTS (epsilon Sinhala)",
    sinhalaText: phase1.sinhalaText,
    scriptStats,
    realtime: {
      model: "gpt-realtime-2",
      ownAudioTtfaMs: phase1.realtimeTtfaMs,
      ownAudioBytes: realtimeBytes,
      ownAudioPeak: peakMagnitude(phase1.realtimeAudioChunks),
      wav: realtimeWavPath,
    },
    epsilon: epsilonOk
      ? {
          ok: true,
          source: phase2.epsilonSource,
          ttfaMs: phase2.epsilonTtfaMs,
          audioBytes: epsilonBytes,
          audioPeak: peakMagnitude(phase2.epsilonAudioChunks),
          durationSec: Number((epsilonBytes / 2 / EPSILON_SAMPLE_RATE_HZ).toFixed(2)),
          wav: epsilonWavPath,
        }
      : {
          ok: false,
          source: phase2.epsilonSource,
          error: phase2.error,
          note: "epsilon endpoint unavailable — set EPSILON_BASE_URL/EPSILON_API_KEY to a live endpoint and re-run for the TTFA + audio A/B",
        },
    listen: epsilonOk
      ? `A/B — realtime native vs epsilon: open ${realtimeWavPath} and ${epsilonWavPath}`
      : `realtime native Sinhala audio: open ${realtimeWavPath}`,
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
