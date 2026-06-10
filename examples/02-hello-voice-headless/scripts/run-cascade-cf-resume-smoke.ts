// SPDX-License-Identifier: MIT
//
// Live CF mid-call drop/resume gate: turn 1 (grounded), abrupt socket kill (no
// close frame), reconnect with the same sessionId inside the resume window,
// assert ready.resumed === true, then turn 2 asks "what did I just ask about?" —
// a grounded answer proves the session (and kuralle conversation memory)
// survived the network blip.

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
const { WaveFile } = require("wavefile") as typeof import("wavefile");

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const FIXTURE_PATH = join(PKG_ROOT, "test", "fixtures", "university-cs-masters-deadline.wav");
const FOLLOWUP_FIXTURE_PATH = join(PKG_ROOT, "test", "fixtures", "what-did-i-just-ask.wav");
const OUTPUT_DIR = join(PKG_ROOT, "test", "performance", "runs", "cascade-cf-resume-smoke");
const INPUT_SAMPLE_RATE_HZ = 16_000;
const FRAME_SAMPLES = 320;

const FOLLOWUP_TEXT = "What did I just ask you about?";

interface TurnResult {
  userTranscript: string;
  agentReply: string;
  audioBytes: number;
}

interface ResumeResult {
  readonly ok: boolean;
  readonly wsUrl: string;
  readonly resumedFlag: boolean | null;
  readonly turn1: TurnResult;
  readonly turn2: TurnResult;
  readonly turn1Grounded: boolean;
  readonly turn2Continuity: boolean;
  readonly reconnectMs: number | null;
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
  throw new Error("SYRINX_CF_CASCADE_URL is required");
}

async function synthesizeFollowupFixture(apiKey: string): Promise<void> {
  if (existsSync(FOLLOWUP_FIXTURE_PATH)) return;
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: FOLLOWUP_TEXT,
      response_format: "pcm",
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI TTS fixture synthesis failed: ${response.status} ${await response.text()}`);
  }
  const pcm = new Uint8Array(await response.arrayBuffer());
  const samples24k = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  const ratio = 24_000 / INPUT_SAMPLE_RATE_HZ;
  const out = new Int16Array(Math.floor(samples24k.length / ratio));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = samples24k[Math.min(samples24k.length - 1, Math.floor(i * ratio))]!;
  }
  const wav = new WaveFile();
  wav.fromScratch(1, INPUT_SAMPLE_RATE_HZ, "16", out);
  await mkdir(dirname(FOLLOWUP_FIXTURE_PATH), { recursive: true });
  await writeFile(FOLLOWUP_FIXTURE_PATH, Buffer.from(wav.toBuffer()));
}

interface OpenConnection {
  readonly socket: InstanceType<typeof WebSocket>;
  readonly readyMessage: Record<string, unknown>;
}

async function openConnection(wsUrl: string): Promise<OpenConnection> {
  const socket = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const readyMessage = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ready timeout")), 30_000);
    socket.on("message", function onMessage(data: RawData, isBinary: boolean) {
      if (isBinary) return;
      const text = data.toString();
      if (!text.startsWith("{")) return;
      const msg = JSON.parse(text) as Record<string, unknown>;
      if (msg.type !== "ready") return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(msg);
    });
  });
  return { socket, readyMessage };
}

async function runTurn(
  socket: InstanceType<typeof WebSocket>,
  fixturePath: string,
  turnId: string,
  doneWhen: (turn: TurnResult) => boolean,
): Promise<TurnResult> {
  const turn: TurnResult = { userTranscript: "", agentReply: "", audioBytes: 0 };
  let errorMessage = "";
  let lastEventAtMs = Date.now();

  const onMessage = (data: RawData, isBinary: boolean): void => {
    const bytes = rawMessageBytes(data);
    if (isBinary || hasSyrinxAudioEnvelope(bytes)) {
      turn.audioBytes += bytes.byteLength;
      lastEventAtMs = Date.now();
      return;
    }
    const text = typeof data === "string" ? data : new TextDecoder().decode(bytes);
    if (!text.startsWith("{")) return;
    const msg = JSON.parse(text) as Record<string, unknown>;
    lastEventAtMs = Date.now();
    if (msg.type === "stt_output") turn.userTranscript = String(msg.transcript ?? "");
    if (msg.type === "agent_chunk") turn.agentReply += String(msg.text ?? "");
    if (msg.type === "error") errorMessage = `${String(msg.component)}: ${String(msg.message)}`;
  };
  socket.on("message", onMessage);

  const sendFrame = (frame: Int16Array): void => {
    socket.send(JSON.stringify({
      type: "audio",
      contextId: turnId,
      sampleRateHz: INPUT_SAMPLE_RATE_HZ,
      audio: pcmToBase64(frame),
    }));
  };

  const pcm = readPcm16Mono16kWav(fixturePath);
  for (let offset = 0; offset < pcm.length; offset += FRAME_SAMPLES) {
    sendFrame(sliceFramePcm(pcm, offset));
    await sleep(20);
  }
  for (let pad = 0; pad < 150; pad += 1) {
    if (doneWhen(turn)) break;
    sendFrame(new Int16Array(FRAME_SAMPLES));
    await sleep(20);
  }

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (errorMessage) {
      socket.off("message", onMessage);
      throw new Error(errorMessage);
    }
    if (doneWhen(turn) && Date.now() - lastEventAtMs > 2_000) break;
    await sleep(250);
  }
  socket.off("message", onMessage);
  return turn;
}

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  const apiKey = process.env["OPENAI_API_KEY"]?.trim();
  if (!apiKey) throw new Error("missing OPENAI_API_KEY in repo-root .env");
  if (!existsSync(FIXTURE_PATH)) {
    throw new Error(`missing fixture ${FIXTURE_PATH} — run run-cascade-cf-smoke.ts once to synthesize it`);
  }
  await synthesizeFollowupFixture(apiKey);
  await mkdir(OUTPUT_DIR, { recursive: true });

  const deployedUrl = deployedBaseUrl();
  const sessionId = `cf-resume-${randomUUID()}`;
  const wsUrl = deployedUrl.replace(/^http/, "ws") + `/ws?sessionId=${encodeURIComponent(sessionId)}`;

  // Turn 1 on connection #1.
  const first = await openConnection(wsUrl);
  if (first.readyMessage.resumed === true) throw new Error("fresh session unexpectedly reported resumed=true");
  const turn1 = await runTurn(
    first.socket,
    FIXTURE_PATH,
    `turn1-${Date.now()}`,
    (turn) => Boolean(turn.userTranscript) && /march\s*31/i.test(turn.agentReply) && turn.audioBytes > 0,
  );

  // Abrupt mid-call kill: no close frame, simulating a network blip.
  first.socket.terminate();
  const reconnectStartedAt = Date.now();
  await sleep(1_500);

  // Reconnect with the same sessionId inside the 15s resume window.
  const second = await openConnection(wsUrl);
  const reconnectMs = Date.now() - reconnectStartedAt;
  const resumedFlag = typeof second.readyMessage.resumed === "boolean" ? second.readyMessage.resumed : null;

  // Turn 2: continuity question — answerable only if the session survived.
  const turn2 = await runTurn(
    second.socket,
    FOLLOWUP_FIXTURE_PATH,
    `turn2-${Date.now()}`,
    (turn) => Boolean(turn.userTranscript) && turn.agentReply.length > 0 && turn.audioBytes > 0,
  );
  second.socket.close();

  const turn1Grounded = /march\s*31/i.test(turn1.agentReply);
  const turn2Continuity = /deadline|march\s*31|computer science|masters|master's/i.test(turn2.agentReply);

  const result: ResumeResult = {
    ok: turn1Grounded && resumedFlag === true && turn2Continuity,
    wsUrl,
    resumedFlag,
    turn1,
    turn2,
    turn1Grounded,
    turn2Continuity,
    reconnectMs,
  };
  await writeFile(join(OUTPUT_DIR, "summary.json"), JSON.stringify(result, null, 2));

  console.log(`\n=== CF RESUME PASS: ${result.ok ? "YES" : "NO"} ===`);
  console.log(`resumed flag on reconnect: ${result.resumedFlag}`);
  console.log(`reconnect time: ${result.reconnectMs}ms`);
  console.log(`turn1 grounded (March 31): ${result.turn1Grounded} — "${turn1.agentReply.slice(0, 90)}"`);
  console.log(`turn2 user transcript: ${turn2.userTranscript}`);
  console.log(`turn2 continuity: ${result.turn2Continuity} — "${turn2.agentReply.slice(0, 120)}"`);

  if (!result.ok) throw new Error("CF resume smoke failed");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
