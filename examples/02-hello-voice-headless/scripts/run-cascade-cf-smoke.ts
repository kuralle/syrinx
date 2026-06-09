// SPDX-License-Identifier: MIT
//
// Live CF cascade gate: connect to deployed syrinx-voice-server-workers,
// stream university CS masters deadline audio, capture kuralle-grounded Deepgram TTS response.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { decodeSyrinxAudioEnvelope, hasSyrinxAudioEnvelope } from "@kuralle-syrinx/core";

import { ensureRepoRootDotenv, readPcm16Mono16kWav } from "../src/run-one-turn.js";

const require = createRequire(import.meta.url);
const WebSocket = require("ws") as typeof import("ws").default;
type RawData = import("ws").RawData;
const { WaveFile } = require("wavefile") as typeof import("wavefile");

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const FIXTURE_PATH = join(PKG_ROOT, "test", "fixtures", "university-cs-masters-deadline.wav");
const OUTPUT_DIR = join(PKG_ROOT, "test", "performance", "runs", "cascade-cf-smoke");
const INPUT_SAMPLE_RATE_HZ = 16_000;
const FRAME_SAMPLES = 320;

const INPUT_TEXT =
  "What's the application deadline for the computer science masters?";

interface SmokeResult {
  readonly ok: boolean;
  readonly deployedUrl: string;
  readonly wsUrl: string;
  readonly userTranscript: string;
  readonly agentReply: string;
  readonly turnTranscript: string;
  readonly audioBytes: number;
  readonly firstAudioLatencyMs: number | null;
  readonly groundedMarch31: boolean;
  readonly outPath: string;
}

function pcmToBase64(frame: Int16Array): string {
  return Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength).toString("base64");
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

function isNonSilentAudio(chunks: readonly Uint8Array[]): boolean {
  const bytes = mergeBytes(chunks);
  if (bytes.byteLength < 4) return false;
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  let peak = 0;
  for (const sample of samples) {
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
  }
  return peak > 100;
}

function containsMarch31(text: string): boolean {
  return /march\s*31/i.test(text);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rawMessageBytes(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) return new Uint8Array(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return new TextEncoder().encode(String(data));
}

function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function deployedBaseUrl(): string {
  const fromEnv = process.env["SYRINX_CF_CASCADE_URL"]?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  throw new Error("SYRINX_CF_CASCADE_URL is required (e.g. https://syrinx-voice-server-workers.<account>.workers.dev)");
}

async function synthesizeInputFixture(apiKey: string): Promise<void> {
  if (existsSync(FIXTURE_PATH)) return;

  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: INPUT_TEXT,
      response_format: "pcm",
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI TTS fixture synthesis failed: ${response.status} ${await response.text()}`);
  }

  const pcm = new Uint8Array(await response.arrayBuffer());
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  const resampled = resample16k(samples, 24_000);
  const wav = new WaveFile();
  wav.fromScratch(1, INPUT_SAMPLE_RATE_HZ, "16", resampled);

  await mkdir(dirname(FIXTURE_PATH), { recursive: true });
  await writeFile(FIXTURE_PATH, Buffer.from(wav.toBuffer()));
}

function resample16k(samples: Int16Array, sourceRateHz: number): Int16Array {
  if (sourceRateHz === INPUT_SAMPLE_RATE_HZ) return samples;
  const ratio = sourceRateHz / INPUT_SAMPLE_RATE_HZ;
  const outLen = Math.floor(samples.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    const src = Math.min(samples.length - 1, Math.floor(i * ratio));
    out[i] = samples[src]!;
  }
  return out;
}

function waitForJson(
  socket: InstanceType<typeof WebSocket>,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket json wait timeout")), timeoutMs);
    const onMessage = (data: { toString(): string } | ArrayBuffer, isBinary: boolean): void => {
      if (isBinary) return;
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (!predicate(msg)) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(msg);
    };
    socket.on("message", onMessage);
  });
}

function sendAudioFrame(socket: InstanceType<typeof WebSocket>, frame: Int16Array, contextId: string): void {
  socket.send(JSON.stringify({
    type: "audio",
    contextId,
    sampleRateHz: INPUT_SAMPLE_RATE_HZ,
    audio: pcmToBase64(frame),
  }));
}

async function runSmoke(deployedUrl: string): Promise<SmokeResult> {
  const sessionId = `cf-cascade-${randomUUID()}`;
  const turnId = `turn-${Date.now()}`;
  const wsUrl = deployedUrl.replace(/^http/, "ws") + `/ws?sessionId=${encodeURIComponent(sessionId)}`;

  const socket = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  await waitForJson(socket, (msg) => msg.type === "ready", 30_000);

  const audioChunks: Uint8Array[] = [];
  let userTranscript = "";
  let agentReply = "";
  let turnTranscript = "";
  let firstAudioAtMs: number | null = null;
  let lastAudioSentAtMs: number | null = null;
  let nextBinary = false;
  let errorMessage = "";
  let lastEventAtMs = Date.now();

  const startedAt = Date.now();
  const touch = (): void => {
    lastEventAtMs = Date.now();
  };

  socket.on("message", (data: RawData, isBinary: boolean) => {
    const bytes = rawMessageBytes(data);
    if (isBinary || hasSyrinxAudioEnvelope(bytes)) {
      if (!nextBinary && !hasSyrinxAudioEnvelope(bytes)) return;
      nextBinary = false;
      const audio = hasSyrinxAudioEnvelope(bytes) ? decodeSyrinxAudioEnvelope(bytes).audio : bytes;
      if (firstAudioAtMs === null) firstAudioAtMs = Date.now() - startedAt;
      audioChunks.push(audio);
      touch();
      return;
    }

    const text = typeof data === "string" ? data : bytesToUtf8(bytes);
    if (!text.startsWith("{")) return;
    const msg = JSON.parse(text) as Record<string, unknown>;
    touch();
    if (msg.type === "stt_output") {
      userTranscript = String(msg.transcript ?? "");
      return;
    }
    if (msg.type === "agent_chunk") {
      agentReply += String(msg.text ?? "");
      return;
    }
    if (msg.type === "tts_chunk") {
      nextBinary = true;
      return;
    }
    if (msg.type === "turn_complete") {
      const transcript = String(msg.transcript ?? "").trim();
      if (transcript && transcript !== userTranscript) {
        turnTranscript = transcript;
      }
      return;
    }
    if (msg.type === "error") {
      errorMessage = `${String(msg.component)}: ${String(msg.message)}`;
    }
  });

  const pcm = readPcm16Mono16kWav(FIXTURE_PATH);
  for (let offset = 0; offset < pcm.length; offset += FRAME_SAMPLES) {
    sendAudioFrame(socket, sliceFramePcm(pcm, offset), turnId);
    lastAudioSentAtMs = Date.now() - startedAt;
    await sleep(20);
  }
  for (let pad = 0; pad < 150; pad += 1) {
    sendAudioFrame(socket, new Int16Array(FRAME_SAMPLES), turnId);
    lastAudioSentAtMs = Date.now() - startedAt;
    await sleep(20);
  }

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (errorMessage) throw new Error(errorMessage);
    const groundedText = `${agentReply} ${turnTranscript}`.trim();
    const idleMs = Date.now() - lastEventAtMs;
    if (
      userTranscript &&
      isNonSilentAudio(audioChunks) &&
      containsMarch31(groundedText) &&
      idleMs > 2_000
    ) {
      break;
    }
    if (userTranscript && idleMs > 20_000 && isNonSilentAudio(audioChunks)) {
      break;
    }
    await sleep(250);
  }

  socket.close();

  if (!isNonSilentAudio(audioChunks)) {
    throw new Error("captured assistant audio is silent");
  }

  const groundedText = `${agentReply} ${turnTranscript} ${userTranscript}`.trim();
  const groundedMarch31 = containsMarch31(groundedText);

  await mkdir(OUTPUT_DIR, { recursive: true });
  const outPath = join(OUTPUT_DIR, "audio-out.wav");
  const merged = mergeBytes(audioChunks);
  const samples = new Int16Array(merged.buffer, merged.byteOffset, Math.floor(merged.byteLength / 2));
  const wav = new WaveFile();
  wav.fromScratch(1, INPUT_SAMPLE_RATE_HZ, "16", samples);
  await writeFile(outPath, Buffer.from(wav.toBuffer()));

  const firstAudioLatencyMs =
    firstAudioAtMs !== null && lastAudioSentAtMs !== null ? firstAudioAtMs - lastAudioSentAtMs : null;

  return {
    ok: groundedMarch31 && isNonSilentAudio(audioChunks),
    deployedUrl,
    wsUrl,
    userTranscript,
    agentReply,
    turnTranscript,
    audioBytes: merged.byteLength,
    firstAudioLatencyMs,
    groundedMarch31,
    outPath,
  };
}

async function probeHealth(deployedUrl: string): Promise<boolean> {
  const response = await fetch(`${deployedUrl}/health`);
  return response.ok && (await response.text()) === "ok";
}

async function probeWsUpgrade(deployedUrl: string): Promise<{ status: number; upgraded: boolean }> {
  const wsUrl = deployedUrl.replace(/^http/, "ws") + `/ws?sessionId=probe-${randomUUID()}`;
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("WS probe timeout"));
    }, 15_000);
    socket.once("open", () => {
      clearTimeout(timer);
      socket.close();
      resolve({ status: 101, upgraded: true });
    });
    socket.once("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  const apiKey = process.env["OPENAI_API_KEY"]?.trim();
  if (!apiKey) throw new Error("missing OPENAI_API_KEY in repo-root .env");

  await synthesizeInputFixture(apiKey);
  await mkdir(OUTPUT_DIR, { recursive: true });

  const deployedUrl = deployedBaseUrl();
  const healthOk = await probeHealth(deployedUrl);
  if (!healthOk) throw new Error(`health check failed for ${deployedUrl}`);

  const wsProbe = await probeWsUpgrade(deployedUrl);
  if (!wsProbe.upgraded) throw new Error("websocket upgrade probe failed");

  const result = await runSmoke(deployedUrl);
  const summaryPath = join(OUTPUT_DIR, "summary.json");
  await writeFile(summaryPath, JSON.stringify(result, null, 2));

  console.log(`\n=== CF CASCADE PASS: ${result.ok ? "YES" : "NO"} ===`);
  console.log(`deployed: ${result.deployedUrl}`);
  console.log(`ws: ${result.wsUrl}`);
  console.log(`first-audio latency (after last frame): ${result.firstAudioLatencyMs}ms`);
  console.log(`user transcript: ${result.userTranscript}`);
  console.log(`agent reply: ${result.agentReply}`);
  console.log(`turn transcript: ${result.turnTranscript}`);
  console.log(`grounded March 31: ${result.groundedMarch31}`);
  console.log(`audio bytes: ${result.audioBytes}`);
  console.log(`out: ${result.outPath}`);
  console.log(JSON.stringify(result, null, 2));

  if (!result.ok) {
    throw new Error("CF cascade smoke failed — missing grounded March 31 or silent audio");
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
