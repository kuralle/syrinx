// SPDX-License-Identifier: MIT

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
import { GrokTTSPlugin } from "@kuralle-syrinx/grok/tts";
import { createNodeWsSocket } from "@kuralle-syrinx/ws/node";

import { ensureRepoRootDotenv } from "../src/run-one-turn.js";

const require = createRequire(import.meta.url);
const { WaveFile } = require("wavefile") as typeof import("wavefile");

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const OUTPUT_DIR = join(PKG_ROOT, "test", "performance", "runs", "grok-tts-smoke");

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

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  const apiKey = process.env["XAI_API_KEY"]?.trim();
  if (!apiKey) throw new Error("missing XAI_API_KEY in repo-root .env");

  await mkdir(OUTPUT_DIR, { recursive: true });

  const bus = new PipelineBusImpl();
  const started = bus.start();
  const plugin = new GrokTTSPlugin(createNodeWsSocket);
  const audioChunks: Uint8Array[] = [];

  bus.on("tts.audio", (pkt) => {
    audioChunks.push((pkt as TextToSpeechAudioPacket).audio);
  });

  const ttsEnd = new Promise<void>((resolveEnd, reject) => {
    const timeout = setTimeout(() => {
      offDone();
      reject(new Error("tts.end timeout"));
    }, 60_000);
    const offDone = bus.on("tts.end", (_pkt) => {
      clearTimeout(timeout);
      offDone();
      resolveEnd();
    });
  });

  await plugin.initialize(bus, {
    api_key: apiKey,
    voice_id: "eve",
    sample_rate: 16000,
    language: "en",
  });

  const contextId = crypto.randomUUID();
  bus.push(Route.Main, {
    kind: "tts.text",
    contextId,
    timestampMs: Date.now(),
    text: "Hello from the Grok TTS smoke test.",
  });
  bus.push(Route.Main, { kind: "tts.done", contextId, timestampMs: Date.now() });

  await ttsEnd;

  if (!isNonSilentAudio(audioChunks)) {
    throw new Error("Grok TTS smoke produced silent audio");
  }

  const bytes = mergeBytes(audioChunks);
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const wav = new WaveFile();
  wav.fromScratch(1, 16000, "16", samples);
  const outPath = join(OUTPUT_DIR, "audio-out.wav");
  await writeFile(outPath, Buffer.from(wav.toBuffer()));

  console.log(JSON.stringify({ ok: true, contextId, audioBytes: bytes.byteLength, outPath }));

  await plugin.close();
  bus.stop();
  await started;
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
