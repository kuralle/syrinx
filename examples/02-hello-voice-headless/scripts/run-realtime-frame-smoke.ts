// SPDX-License-Identifier: MIT
//
// Live acceptance gate for WBS-1: open gpt-realtime-2, send one fixture turn,
// capture provider audio, resample 24k→16k, round-trip through Syrinx envelope codec.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  decodeSyrinxAudioEnvelope,
  encodeSyrinxAudioEnvelope,
} from "@kuralle-syrinx/core";
import { fromOpenAIRealtime } from "@kuralle-syrinx/realtime";
import { createNodeWsSocket } from "@kuralle-syrinx/ws/node";

import { ensureRepoRootDotenv } from "../src/run-one-turn.js";

const require = createRequire(import.meta.url);
const { WaveFile } = require("wavefile") as typeof import("wavefile");

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const FIXTURE_PATH = join(PKG_ROOT, "test", "fixtures", "university-support-add-drop.wav");
const INPUT_SAMPLE_RATE_HZ = 16_000;
const PROVIDER_SAMPLE_RATE_HZ = 24_000;
const FRAME_SAMPLES = 480;

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

function readMono16kWav(path: string): Int16Array {
  const wav = new WaveFile(readFileSync(path));
  const fmt = wav.fmt as {
    sampleRate: number;
    numChannels: number;
    bitsPerSample: number;
    audioFormat: number;
  };
  if (fmt.numChannels !== 1) throw new Error(`expected mono WAV, got ${String(fmt.numChannels)} channels`);
  if (fmt.bitsPerSample !== 16 || fmt.audioFormat !== 1) throw new Error("expected 16-bit PCM WAV");
  const raw = wav.getSamples(false, Int16Array);
  const mono: Int16Array | undefined = Array.isArray(raw) ? raw[0] : raw;
  if (mono === undefined || !(mono instanceof Int16Array)) throw new Error("WAV has no mono channel samples");
  return fmt.sampleRate === INPUT_SAMPLE_RATE_HZ
    ? mono
    : resamplePcm16(mono, fmt.sampleRate, INPUT_SAMPLE_RATE_HZ);
}

function pcmToBytes(samples: Readonly<Int16Array>): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  const apiKey = process.env["OPENAI_API_KEY"]?.trim();
  if (!apiKey) throw new Error("missing OPENAI_API_KEY in repo-root .env");

  const input16k = readMono16kWav(FIXTURE_PATH);
  const input24k = resamplePcm16(input16k, INPUT_SAMPLE_RATE_HZ, PROVIDER_SAMPLE_RATE_HZ);

  const adapter = fromOpenAIRealtime({
    apiKey,
    socketFactory: createNodeWsSocket,
    // Deterministic end-of-turn for the gate (semantic_vad can be too conservative on synthetic TTS).
    turnDetection: { type: "server_vad", silence_duration_ms: 500 },
  });

  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 45_000);

  try {
    await adapter.open(abort.signal);

    let offset = 0;
    while (offset < input24k.length) {
      const end = Math.min(offset + FRAME_SAMPLES, input24k.length);
      adapter.sendAudio(pcmToBytes(input24k.subarray(offset, end)));
      offset = end;
      await sleep(20);
    }

    for (let pad = 0; pad < 100; pad += 1) {
      adapter.sendAudio(new Uint8Array(FRAME_SAMPLES * 2));
      await sleep(20);
    }

    let capturedAudio: Uint8Array | null = null;
    for await (const event of adapter.events) {
      console.error(`[event] ${event.type}${event.type === "error" ? ` recoverable=${event.recoverable} cause=${event.cause.message}` : ""}${event.type === "transcript" ? ` "${event.text}"` : ""}`);
      if (event.type === "audio") {
        capturedAudio = event.pcm16;
        break;
      }
      if (event.type === "error" && !event.recoverable) {
        throw event.cause;
      }
    }

    if (!capturedAudio || capturedAudio.byteLength === 0) {
      throw new Error("no provider audio event captured");
    }

    const pcm16At16k = resamplePcm16(
      new Int16Array(capturedAudio.buffer, capturedAudio.byteOffset, capturedAudio.byteLength / 2),
      PROVIDER_SAMPLE_RATE_HZ,
      INPUT_SAMPLE_RATE_HZ,
    );
    const audio16k = pcmToBytes(pcm16At16k);
    const durationMs = Math.round((audio16k.byteLength / 2 / INPUT_SAMPLE_RATE_HZ) * 1000);

    const envelope = encodeSyrinxAudioEnvelope(
      {
        type: "audio",
        sampleRateHz: INPUT_SAMPLE_RATE_HZ,
        encoding: "pcm_s16le",
        channels: 1,
        byteLength: audio16k.byteLength,
        durationMs,
      },
      audio16k,
    );
    decodeSyrinxAudioEnvelope(envelope);

    console.log(
      JSON.stringify({
        ok: true,
        capturedBytes: capturedAudio.byteLength,
        resampledBytes: audio16k.byteLength,
        durationMs,
      }),
    );
  } finally {
    clearTimeout(timeout);
    await adapter.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
