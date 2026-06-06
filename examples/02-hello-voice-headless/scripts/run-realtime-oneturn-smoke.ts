// SPDX-License-Identifier: MIT
//
// Live acceptance gate for WBS-2: one turn through VoiceAgentSession with only
// RealtimeBridge — fixture audio in, gpt-realtime-2 audio out via tts.audio.

import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Route,
  VoiceAgentSession,
  type TextToSpeechAudioPacket,
  type TextToSpeechEndPacket,
} from "@kuralle-syrinx/core";
import { RealtimeBridge, fromOpenAIRealtime } from "@kuralle-syrinx/realtime";
import { createNodeWsSocket } from "@kuralle-syrinx/ws/node";

import { ensureRepoRootDotenv, readPcm16Mono16kWav } from "../src/run-one-turn.js";

const require = createRequire(import.meta.url);
const { WaveFile } = require("wavefile") as typeof import("wavefile");

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const FIXTURE_PATH = join(PKG_ROOT, "test", "fixtures", "university-support-add-drop.wav");
const OUTPUT_DIR = join(PKG_ROOT, "test", "performance", "runs", "realtime-oneturn-smoke");
const INPUT_SAMPLE_RATE_HZ = 16_000;
const FRAME_SAMPLES = 320;

function pcmToBytes(samples: Readonly<Int16Array>): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
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

function writePcm16Wav(path: string, chunks: readonly Uint8Array[], sampleRateHz: number): Promise<void> {
  const bytes = mergeBytes(chunks);
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const wav = new WaveFile();
  wav.fromScratch(1, sampleRateHz, "16", samples);
  return writeFile(path, Buffer.from(wav.toBuffer()));
}

function isNonSilentAudio(chunks: readonly Uint8Array[]): boolean {
  const bytes = mergeBytes(chunks);
  if (bytes.byteLength < 4) return false;
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  let peak = 0;
  for (const sample of samples) {
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
  }
  return peak > 100;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  const apiKey = process.env["OPENAI_API_KEY"]?.trim();
  if (!apiKey) throw new Error("missing OPENAI_API_KEY in repo-root .env");

  await mkdir(OUTPUT_DIR, { recursive: true });

  const pcm = readPcm16Mono16kWav(FIXTURE_PATH);
  const adapter = fromOpenAIRealtime({
    apiKey,
    socketFactory: createNodeWsSocket,
    turnDetection: { type: "server_vad", silence_duration_ms: 500 },
  });
  const bridge = new RealtimeBridge(adapter);

  const session = new VoiceAgentSession({
    plugins: { realtime: {} },
    endpointingOwner: "timer",
  });
  session.registerPlugin("realtime", bridge);

  const outputChunks: Uint8Array[] = [];
  let responseContextId = "";

  const offTtsAudio = session.bus.on<TextToSpeechAudioPacket>("tts.audio", (pkt) => {
    if (responseContextId.length === 0) responseContextId = pkt.contextId;
    if (pkt.contextId !== responseContextId) return;
    outputChunks.push(pkt.audio);
  });

  const ttsEnd = new Promise<void>((resolveEnd, reject) => {
    const timeout = setTimeout(() => {
      offDone();
      reject(new Error("tts.end timeout"));
    }, 120_000);
    const offDone = session.bus.on<TextToSpeechEndPacket>("tts.end", (pkt) => {
      if (responseContextId.length > 0 && pkt.contextId !== responseContextId) return;
      clearTimeout(timeout);
      offDone();
      resolveEnd();
    });
  });

  await session.start();

  const transportContextId = crypto.randomUUID();
  let offset = 0;
  while (offset < pcm.length) {
    const frame = sliceFramePcm(pcm, offset);
    session.bus.push(Route.Main, {
      kind: "user.audio_received",
      contextId: transportContextId,
      timestampMs: Date.now(),
      audio: pcmToBytes(frame),
    });
    offset += FRAME_SAMPLES;
    await sleep(20);
  }

  for (let pad = 0; pad < 100; pad += 1) {
    session.bus.push(Route.Main, {
      kind: "user.audio_received",
      contextId: transportContextId,
      timestampMs: Date.now(),
      audio: pcmToBytes(new Int16Array(FRAME_SAMPLES)),
    });
    await sleep(20);
  }

  await ttsEnd;
  offTtsAudio();

  if (!isNonSilentAudio(outputChunks)) {
    throw new Error("captured assistant audio is silent");
  }

  const outPath = join(OUTPUT_DIR, "audio-out.wav");
  await writePcm16Wav(outPath, outputChunks, INPUT_SAMPLE_RATE_HZ);

  console.log(
    JSON.stringify({
      ok: true,
      responseContextId,
      audioBytes: mergeBytes(outputChunks).byteLength,
      outPath,
    }),
  );

  await session.close();
  await adapter.close();
  process.exit(0);
}

main().catch(async (err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
