// SPDX-License-Identifier: MIT
//
// Live acceptance gate: Gemini Live front + kuralle back — barge-in mid-response.

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Route,
  VoiceAgentSession,
  type InterruptTtsPacket,
  type TextToSpeechAudioPacket,
  type TextToSpeechEndPacket,
  type TurnChangePacket,
} from "@kuralle-syrinx/core";
import { fromKuralleRuntime, type KuralleRuntimeLike } from "@kuralle-syrinx/kuralle";
import { RealtimeBridge, fromGeminiLive } from "@kuralle-syrinx/realtime";
import type { RealtimeToolDef } from "@kuralle-syrinx/realtime";

import { ensureRepoRootDotenv, readPcm16Mono16kWav } from "../src/run-one-turn.js";
import { createFullUniversityRuntime } from "../src/university-agent-full.js";

const require = createRequire(import.meta.url);
const { WaveFile } = require("wavefile") as typeof import("wavefile");

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const FIXTURE_PATH = join(PKG_ROOT, "test", "fixtures", "university-support-add-drop.wav");
const OUTPUT_DIR = join(PKG_ROOT, "test", "performance", "runs", "realtime-gemini-bargein-smoke");
const INPUT_SAMPLE_RATE_HZ = 16_000;
const FRAME_SAMPLES = 320;
const GEMINI_LIVE_MODEL = "gemini-3.1-flash-live-preview";

const ASK_UNIVERSITY_TOOL: RealtimeToolDef = {
  name: "ask_university",
  description: "Answer university student-relations questions (enrollment, add/drop, advising).",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

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

async function streamFixture(
  session: VoiceAgentSession,
  pcm: Int16Array,
  transportContextId: string,
): Promise<void> {
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
}

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  const apiKey = process.env["GEMINI_API_KEY"]?.trim();
  if (!apiKey) throw new Error("missing GEMINI_API_KEY in repo-root .env");

  await mkdir(OUTPUT_DIR, { recursive: true });

  const pcm = readPcm16Mono16kWav(FIXTURE_PATH);
  const adapter = fromGeminiLive({
    apiKey,
    model: GEMINI_LIVE_MODEL,
    tools: [ASK_UNIVERSITY_TOOL],
  });

  const { runtime } = await createFullUniversityRuntime();
  const universityReasoner = fromKuralleRuntime(runtime as unknown as KuralleRuntimeLike, {
    sessionId: `gemini-bargein-${randomUUID()}`,
    userId: "bimodel",
  });

  const bridge = new RealtimeBridge(adapter, universityReasoner, ASK_UNIVERSITY_TOOL.name);

  const session = new VoiceAgentSession({
    plugins: { realtime: {} },
    endpointingOwner: "timer",
    minInterruptionMs: 0,
  });
  session.registerPlugin("realtime", bridge);

  const turnChanges: TurnChangePacket[] = [];
  const interrupts: InterruptTtsPacket[] = [];
  const chunksByContext = new Map<string, Uint8Array[]>();
  let bargeInAtMs = 0;
  let postBargeBytes = 0;

  session.bus.on("turn.change", (pkt) => { turnChanges.push(pkt as TurnChangePacket); });
  session.bus.on("interrupt.tts", (pkt) => {
    interrupts.push(pkt as InterruptTtsPacket);
    bargeInAtMs = Date.now();
  });
  session.bus.on<TextToSpeechAudioPacket>("tts.audio", (pkt) => {
    const list = chunksByContext.get(pkt.contextId) ?? [];
    list.push(pkt.audio);
    chunksByContext.set(pkt.contextId, list);
    if (bargeInAtMs > 0) postBargeBytes += pkt.audio.byteLength;
  });

  await session.start();

  const transportContextId = crypto.randomUUID();
  await streamFixture(session, pcm, transportContextId);

  for (let pad = 0; pad < 50; pad += 1) {
    session.bus.push(Route.Main, {
      kind: "user.audio_received",
      contextId: transportContextId,
      timestampMs: Date.now(),
      audio: pcmToBytes(new Int16Array(FRAME_SAMPLES)),
    });
    await sleep(20);
  }

  const firstTurnContext = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("first turn timeout")), 90_000);
    const check = setInterval(() => {
      if (turnChanges.length >= 1) {
        clearTimeout(timeout);
        clearInterval(check);
        resolve(turnChanges[0]!.contextId);
      }
    }, 50);
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("first audio timeout")), 90_000);
    const check = setInterval(() => {
      const chunks = chunksByContext.get(firstTurnContext) ?? [];
      if (mergeBytes(chunks).byteLength > 8_000) {
        clearTimeout(timeout);
        clearInterval(check);
        resolve();
      }
    }, 50);
  });

  await streamFixture(session, pcm, transportContextId);

  for (let pad = 0; pad < 50; pad += 1) {
    session.bus.push(Route.Main, {
      kind: "user.audio_received",
      contextId: transportContextId,
      timestampMs: Date.now(),
      audio: pcmToBytes(new Int16Array(FRAME_SAMPLES)),
    });
    await sleep(20);
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("barge-in timeout")), 60_000);
    const check = setInterval(() => {
      if (interrupts.length >= 1) {
        clearTimeout(timeout);
        clearInterval(check);
        resolve();
      }
    }, 50);
  });

  const secondTurnEnd = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("second turn timeout")), 120_000);
    const off = session.bus.on<TextToSpeechEndPacket>("tts.end", (pkt) => {
      if (pkt.contextId !== firstTurnContext) {
        clearTimeout(timeout);
        off();
        resolve(pkt.contextId);
      }
    });
  });

  await streamFixture(session, pcm, transportContextId);

  for (let pad = 0; pad < 100; pad += 1) {
    session.bus.push(Route.Main, {
      kind: "user.audio_received",
      contextId: transportContextId,
      timestampMs: Date.now(),
      audio: pcmToBytes(new Int16Array(FRAME_SAMPLES)),
    });
    await sleep(20);
  }

  const secondTurnContext = await secondTurnEnd;
  const secondTurnChunks = chunksByContext.get(secondTurnContext) ?? [];

  if (!isNonSilentAudio(secondTurnChunks)) {
    throw new Error("second turn assistant audio is silent");
  }

  const firstTurnChunks = chunksByContext.get(firstTurnContext) ?? [];
  const outFirst = join(OUTPUT_DIR, "turn1-pre-barge.wav");
  const outSecond = join(OUTPUT_DIR, "turn2-post-barge.wav");
  await writePcm16Wav(outFirst, firstTurnChunks, INPUT_SAMPLE_RATE_HZ);
  await writePcm16Wav(outSecond, secondTurnChunks, INPUT_SAMPLE_RATE_HZ);

  console.log(
    JSON.stringify({
      ok: true,
      model: GEMINI_LIVE_MODEL,
      firstTurnContext,
      secondTurnContext,
      interruptCount: interrupts.length,
      firstTurnAudioBytes: mergeBytes(firstTurnChunks).byteLength,
      secondTurnAudioBytes: mergeBytes(secondTurnChunks).byteLength,
      postBargeBytes,
      outFirst,
      outSecond,
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
