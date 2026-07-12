// SPDX-License-Identifier: MIT
//
// Live proof of the absolute turn-duration cap: stream the real question WAV, then
// CONTINUOUS low-level noise with NO trailing silence gap — the exact condition that
// used to hang a turn forever (VAD never sees silence → no endpoint → no reply).
// With the cap, the turn must still terminate (grounded response) within ~cap+margin.
//
// Usage: SYRINX_CF_CASCADE_URL=<spike url> npx tsx scripts/run-turn-cap-live-proof.ts

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { decodeSyrinxAudioEnvelope, hasSyrinxAudioEnvelope } from "@kuralle-syrinx/core";
import { ensureRepoRootDotenv, readPcm16Mono16kWav } from "../src/run-one-turn.js";

const require = createRequire(import.meta.url);
const WebSocket = require("ws") as typeof import("ws").default;
type RawData = import("ws").RawData;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const FIXTURE_PATH = join(PKG_ROOT, "test", "fixtures", "university-cs-masters-deadline.wav");
const INPUT_SAMPLE_RATE_HZ = 16_000;
const FRAME_SAMPLES = 320;
const NOISE_SECONDS = 18; // longer than the 15s cap so the cap must fire during the noise
const NOISE_AMPLITUDE = 1200; // ~3.7% full scale — enough to keep server VAD from idling to silence

function deployedBaseUrl(): string {
  const fromEnv = process.env["SYRINX_CF_CASCADE_URL"]?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  throw new Error("SYRINX_CF_CASCADE_URL is required");
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
// Deterministic pseudo-noise frame (no Math.random dependency; varies per index).
function noiseFrame(seed: number): Int16Array {
  const frame = new Int16Array(FRAME_SAMPLES);
  let x = (seed * 2654435761) >>> 0;
  for (let i = 0; i < FRAME_SAMPLES; i += 1) {
    x = (x * 1103515245 + 12345) >>> 0;
    frame[i] = (((x >>> 16) & 0xffff) / 0xffff) * 2 * NOISE_AMPLITUDE - NOISE_AMPLITUDE;
  }
  return frame;
}
function rawMessageBytes(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) return new Uint8Array(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return new TextEncoder().encode(String(data));
}
function isNonSilent(chunks: Uint8Array[]): boolean {
  let peak = 0;
  for (const c of chunks) {
    const s = new Int16Array(c.buffer, c.byteOffset, Math.floor(c.byteLength / 2));
    for (const v of s) if (Math.abs(v) > peak) peak = Math.abs(v);
  }
  return peak > 100;
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function sendFrame(socket: InstanceType<typeof WebSocket>, frame: Int16Array, contextId: string): void {
  socket.send(JSON.stringify({ type: "audio", contextId, sampleRateHz: INPUT_SAMPLE_RATE_HZ, audio: pcmToBase64(frame) }));
}

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  const url = deployedBaseUrl();
  const sessionId = `turncap-${randomUUID()}`;
  const turnId = `turn-${Date.now()}`;
  const wsUrl = url.replace(/^http/, "ws") + `/ws?sessionId=${encodeURIComponent(sessionId)}`;
  const socket = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  const audioChunks: Uint8Array[] = [];
  let agentReply = "";
  let userTranscript = "";
  let ready = false;
  let nextBinary = false;
  let firstReplyAtMs: number | null = null;
  let lastRealSpeechAtMs: number | null = null;
  const startMs = Date.now();

  socket.on("message", (data: RawData, isBinary: boolean) => {
    const bytes = rawMessageBytes(data);
    if (isBinary || hasSyrinxAudioEnvelope(bytes)) {
      if (!nextBinary && !hasSyrinxAudioEnvelope(bytes)) return;
      nextBinary = false;
      const audio = hasSyrinxAudioEnvelope(bytes) ? decodeSyrinxAudioEnvelope(bytes).audio : bytes;
      if (audio.byteLength > 0 && firstReplyAtMs === null) firstReplyAtMs = Date.now();
      audioChunks.push(audio);
      return;
    }
    const text = new TextDecoder().decode(bytes);
    if (!text.startsWith("{")) return;
    const msg = JSON.parse(text) as Record<string, unknown>;
    if (msg["type"] === "ready") ready = true;
    else if (msg["type"] === "stt_output") userTranscript = String(msg["transcript"] ?? "");
    else if (msg["type"] === "agent_chunk") {
      if (firstReplyAtMs === null) firstReplyAtMs = Date.now();
      agentReply += String(msg["text"] ?? "");
    } else if (msg["type"] === "tts_chunk") nextBinary = true;
  });

  const deadline = Date.now() + 8000;
  while (!ready && Date.now() < deadline) await sleep(50);

  // 1) The real question.
  const pcm = readPcm16Mono16kWav(FIXTURE_PATH);
  for (let off = 0; off < pcm.length; off += FRAME_SAMPLES) {
    sendFrame(socket, sliceFramePcm(pcm, off), turnId);
    await sleep(20);
  }
  lastRealSpeechAtMs = Date.now();
  // 2) Continuous NOISE — no silence gap. This is what used to hang the turn.
  const noiseFrames = Math.round((NOISE_SECONDS * 1000) / 20);
  for (let i = 0; i < noiseFrames; i += 1) {
    sendFrame(socket, noiseFrame(i), turnId);
    await sleep(20);
    if (agentReply || isNonSilent(audioChunks)) break; // terminated — stop early
  }
  // grace for audio tail
  const graceEnd = Date.now() + 4000;
  while (Date.now() < graceEnd && !isNonSilent(audioChunks)) await sleep(200);

  socket.close();

  const terminated = Boolean(agentReply) || isNonSilent(audioChunks);
  const ttReplyMs = firstReplyAtMs !== null && lastRealSpeechAtMs !== null ? firstReplyAtMs - lastRealSpeechAtMs : null;
  console.log("\n=== TURN-CAP LIVE PROOF ===");
  console.log(`deployed: ${url}`);
  console.log(`user transcript: ${userTranscript}`);
  console.log(`agent reply: ${agentReply || "(none)"}`);
  console.log(`assistant audio bytes: ${audioChunks.reduce((s, c) => s + c.byteLength, 0)}`);
  console.log(`time from end-of-real-speech to first reply: ${ttReplyMs === null ? "n/a" : `${String(ttReplyMs)}ms`}`);
  console.log(`total elapsed: ${Date.now() - startMs}ms`);
  console.log(terminated ? "PASS: turn terminated under continuous noise (guarantee holds)" : "FAIL: turn hung — no response under continuous noise");
  process.exit(terminated ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
});
