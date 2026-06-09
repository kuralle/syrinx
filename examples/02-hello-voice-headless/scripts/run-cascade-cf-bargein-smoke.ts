// SPDX-License-Identifier: MIT
//
// Live CF cascade barge-in gate: connect to deployed syrinx-voice-server-workers,
// stream the deadline question, then stream a second utterance while the agent's
// TTS is still playing out and require agent_interrupted + audio_clear (provider-STT
// barge-in — no VAD plugin on the edge worker).

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { hasSyrinxAudioEnvelope } from "@kuralle-syrinx/core";

import { ensureRepoRootDotenv, readPcm16Mono16kWav } from "../src/run-one-turn.js";

const require = createRequire(import.meta.url);
const WebSocket = require("ws") as typeof import("ws").default;
type RawData = import("ws").RawData;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const FIXTURE_PATH = join(PKG_ROOT, "test", "fixtures", "university-cs-masters-deadline.wav");
const OUTPUT_DIR = join(PKG_ROOT, "test", "performance", "runs", "cascade-cf-bargein-smoke");
const INPUT_SAMPLE_RATE_HZ = 16_000;
const FRAME_SAMPLES = 320;

interface BargeInResult {
  readonly ok: boolean;
  readonly wsUrl: string;
  readonly userTranscript: string;
  readonly ttsStartedAtMs: number | null;
  readonly bargeInStartedAtMs: number | null;
  readonly agentInterruptedAtMs: number | null;
  readonly audioClearReceived: boolean;
  readonly interruptLatencyFromBargeInMs: number | null;
  readonly ttsChunksAfterInterruptGrace: number;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rawMessageBytes(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) return new Uint8Array(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return new TextEncoder().encode(String(data));
}

function deployedBaseUrl(): string {
  const fromEnv = process.env["SYRINX_CF_CASCADE_URL"]?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  throw new Error("SYRINX_CF_CASCADE_URL is required (e.g. https://syrinx-voice-server-workers.<account>.workers.dev)");
}

function sendAudioFrame(socket: InstanceType<typeof WebSocket>, frame: Int16Array, contextId: string): void {
  socket.send(JSON.stringify({
    type: "audio",
    contextId,
    sampleRateHz: INPUT_SAMPLE_RATE_HZ,
    audio: pcmToBase64(frame),
  }));
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

async function runBargeInSmoke(deployedUrl: string): Promise<BargeInResult> {
  const sessionId = `cf-cascade-bargein-${randomUUID()}`;
  const turnId = `turn-${Date.now()}`;
  const bargeInTurnId = `turn-bargein-${Date.now()}`;
  const wsUrl = deployedUrl.replace(/^http/, "ws") + `/ws?sessionId=${encodeURIComponent(sessionId)}`;

  const socket = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  await waitForJson(socket, (msg) => msg.type === "ready", 30_000);

  const startedAt = Date.now();
  let userTranscript = "";
  let ttsStartedAtMs: number | null = null;
  let agentInterruptedAtMs: number | null = null;
  let audioClearReceived = false;
  let errorMessage = "";
  let ttsChunksAfterInterruptGrace = 0;
  const interruptGraceMs = 2_000;

  socket.on("message", (data: RawData, isBinary: boolean) => {
    const bytes = rawMessageBytes(data);
    if (isBinary || hasSyrinxAudioEnvelope(bytes)) {
      if (ttsStartedAtMs === null) ttsStartedAtMs = Date.now() - startedAt;
      if (agentInterruptedAtMs !== null && Date.now() - startedAt > agentInterruptedAtMs + interruptGraceMs) {
        ttsChunksAfterInterruptGrace += 1;
      }
      return;
    }
    const text = typeof data === "string" ? data : new TextDecoder().decode(bytes);
    if (!text.startsWith("{")) return;
    const msg = JSON.parse(text) as Record<string, unknown>;
    if (msg.type === "stt_output" && !userTranscript) {
      userTranscript = String(msg.transcript ?? "");
      return;
    }
    if (msg.type === "audio_clear") {
      audioClearReceived = true;
      return;
    }
    if (msg.type === "agent_interrupted" && agentInterruptedAtMs === null) {
      agentInterruptedAtMs = Date.now() - startedAt;
      return;
    }
    if (msg.type === "error") {
      errorMessage = `${String(msg.component)}: ${String(msg.message)}`;
    }
  });

  // Turn 1: stream the question, then padding silence so Deepgram endpoints.
  const pcm = readPcm16Mono16kWav(FIXTURE_PATH);
  for (let offset = 0; offset < pcm.length; offset += FRAME_SAMPLES) {
    sendAudioFrame(socket, sliceFramePcm(pcm, offset), turnId);
    await sleep(20);
  }
  for (let pad = 0; pad < 150; pad += 1) {
    if (ttsStartedAtMs !== null) break;
    sendAudioFrame(socket, new Int16Array(FRAME_SAMPLES), turnId);
    await sleep(20);
  }

  // Wait for the agent's TTS audio to start streaming.
  const ttsDeadline = Date.now() + 60_000;
  while (ttsStartedAtMs === null && Date.now() < ttsDeadline) {
    if (errorMessage) throw new Error(errorMessage);
    sendAudioFrame(socket, new Int16Array(FRAME_SAMPLES), turnId);
    await sleep(20);
  }
  if (ttsStartedAtMs === null) throw new Error("agent TTS never started — cannot test barge-in");

  // Barge in: stream the second utterance while the agent is mid-playout.
  const bargeInStartedAtMs = Date.now() - startedAt;
  for (let offset = 0; offset < pcm.length; offset += FRAME_SAMPLES) {
    if (agentInterruptedAtMs !== null && offset > pcm.length / 2) break;
    sendAudioFrame(socket, sliceFramePcm(pcm, offset), bargeInTurnId);
    await sleep(20);
  }

  // Wait for the interrupt to land (plus grace to count late TTS chunks).
  const interruptDeadline = Date.now() + 20_000;
  while (agentInterruptedAtMs === null && Date.now() < interruptDeadline) {
    if (errorMessage) throw new Error(errorMessage);
    sendAudioFrame(socket, new Int16Array(FRAME_SAMPLES), bargeInTurnId);
    await sleep(20);
  }
  if (agentInterruptedAtMs !== null) await sleep(interruptGraceMs + 1_000);

  socket.close();

  const interruptLatencyFromBargeInMs =
    agentInterruptedAtMs !== null ? agentInterruptedAtMs - bargeInStartedAtMs : null;

  return {
    ok: agentInterruptedAtMs !== null && audioClearReceived && ttsChunksAfterInterruptGrace === 0,
    wsUrl,
    userTranscript,
    ttsStartedAtMs,
    bargeInStartedAtMs,
    agentInterruptedAtMs,
    audioClearReceived,
    interruptLatencyFromBargeInMs,
    ttsChunksAfterInterruptGrace,
  };
}

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  if (!existsSync(FIXTURE_PATH)) {
    throw new Error(`missing fixture ${FIXTURE_PATH} — run run-cascade-cf-smoke.ts once to synthesize it`);
  }
  await mkdir(OUTPUT_DIR, { recursive: true });

  const deployedUrl = deployedBaseUrl();
  const healthResponse = await fetch(`${deployedUrl}/health`);
  if (!healthResponse.ok) throw new Error(`health check failed for ${deployedUrl}`);

  const result = await runBargeInSmoke(deployedUrl);
  await writeFile(join(OUTPUT_DIR, "summary.json"), JSON.stringify(result, null, 2));

  console.log(`\n=== CF CASCADE BARGE-IN PASS: ${result.ok ? "YES" : "NO"} ===`);
  console.log(`ws: ${result.wsUrl}`);
  console.log(`tts started at: ${result.ttsStartedAtMs}ms`);
  console.log(`barge-in started at: ${result.bargeInStartedAtMs}ms`);
  console.log(`agent_interrupted at: ${result.agentInterruptedAtMs}ms`);
  console.log(`audio_clear received: ${result.audioClearReceived}`);
  console.log(`interrupt latency from barge-in start: ${result.interruptLatencyFromBargeInMs}ms`);
  console.log(`tts chunks after interrupt+grace: ${result.ttsChunksAfterInterruptGrace}`);

  if (!result.ok) {
    throw new Error("CF cascade barge-in smoke failed");
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
