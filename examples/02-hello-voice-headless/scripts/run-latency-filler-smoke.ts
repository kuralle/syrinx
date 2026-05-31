// SPDX-License-Identifier: MIT
//
// VE-03 live smoke: A/B endpoint→first-audio latency with latency filler on vs off.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import WebSocket, { type RawData } from "ws";

import { createVoiceWebSocketServer } from "@asyncdot/voice-server-websocket";

import { coerceGoogleGenAiKey, ensureRepoRootDotenv, readPcm16Mono16kWav } from "../src/run-one-turn.js";
import { createUniversitySupportSession } from "../src/university-support-agent.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const RUNS_DIR = join(PKG_ROOT, "test", "performance", "runs");
const FIXTURE_PATH = join(
  PKG_ROOT,
  "test",
  "fixtures",
  "university-support-add-drop.wav",
);
const INPUT_SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 320;
const TRAILING_SILENCE_MS = 1400;
const POST_TTS_DRAIN_MS = 500;

interface TurnCapture {
  speechEndedAtMs: number;
  firstAudioAtMs: number;
  firstAgentAtMs: number;
  agentReply: string;
  audioBytes: number;
  error: string;
}

export interface LatencyFillerSmokeArm {
  readonly latencyFillerEnabled: boolean;
  readonly speechEndToFirstAudioMs: number;
  readonly vadSpeechEndToFirstAudioMs: number;
  readonly audioBytes: number;
}

export interface LatencyFillerSmokeResult {
  readonly off: LatencyFillerSmokeArm;
  readonly on: LatencyFillerSmokeArm;
  readonly qualityGate: { readonly passed: boolean; readonly failures: readonly string[] };
}

export function evaluateLatencyFillerSmoke(result: LatencyFillerSmokeResult): string[] {
  const failures: string[] = [];
  if (result.off.speechEndToFirstAudioMs <= 0 || result.on.speechEndToFirstAudioMs <= 0) {
    failures.push("missing endpoint→first-audio measurement");
  }
  if (result.on.speechEndToFirstAudioMs >= result.off.speechEndToFirstAudioMs) {
    failures.push(
      `expected filler-on latency (${String(result.on.speechEndToFirstAudioMs)}ms) ` +
        `< filler-off (${String(result.off.speechEndToFirstAudioMs)}ms)`,
    );
  }
  if (result.on.audioBytes <= 0 || result.off.audioBytes <= 0) {
    failures.push("expected assistant audio in both arms");
  }
  return failures;
}

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  coerceGoogleGenAiKey();
  requireEnv("DEEPGRAM_API_KEY");
  requireEnv("GOOGLE_GENERATIVE_AI_API_KEY");
  requireEnv("CARTESIA_API_KEY");

  const generatedAt = new Date().toISOString();
  const runId = generatedAt.replaceAll(":", "-").replaceAll(".", "-");
  const runDir = join(RUNS_DIR, `latency-filler-ab-${runId}`);
  await mkdir(runDir, { recursive: true });

  const off = await runArm(false);
  const on = await runArm(true);
  const failures = evaluateLatencyFillerSmoke({ off, on, qualityGate: { passed: false, failures: [] } });
  const qualityGate = { passed: failures.length === 0, failures };
  const result: LatencyFillerSmokeResult = { off, on, qualityGate };

  const baseline = {
    scenario: "latency_filler_ab_interactive",
    generatedAt,
    fixturePath: relative(PKG_ROOT, FIXTURE_PATH),
    off,
    on,
    deltaMs: {
      speechEndToFirstAudio: off.speechEndToFirstAudioMs - on.speechEndToFirstAudioMs,
      vadSpeechEndToFirstAudio: off.vadSpeechEndToFirstAudioMs - on.vadSpeechEndToFirstAudioMs,
    },
    qualityGate: result.qualityGate,
    runDir: relative(PKG_ROOT, runDir),
  };

  await writeFile(join(runDir, "baseline.json"), `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(baseline, null, 2));
  if (failures.length > 0) {
    throw new Error(`latency filler smoke failed: ${failures.join("; ")}`);
  }
}

async function runArm(latencyFillerEnabled: boolean): Promise<LatencyFillerSmokeArm> {
  const server = await createVoiceWebSocketServer({
    port: 0,
    createSession: () => createUniversitySupportSession({
      inputSampleRate: INPUT_SAMPLE_RATE,
      profile: "interactive",
      ttsProvider: "cartesia",
      latencyFillerEnabled,
    }),
    contextId: () => "latency-filler-smoke",
  });

  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP websocket address");
    const socket = await openSocket(`ws://127.0.0.1:${String(address.port)}/ws`);
    const turn = await runTurn(socket);
    socket.close();
    return {
      latencyFillerEnabled,
      speechEndToFirstAudioMs: turn.firstAudioAtMs - turn.audioEndedAtMs,
      vadSpeechEndToFirstAudioMs: turn.firstAudioAtMs - turn.speechEndedAtMs,
      audioBytes: turn.audioBytes,
    };
  } finally {
    await server.close();
  }
}

async function runTurn(socket: WebSocket): Promise<TurnCapture & { audioEndedAtMs: number }> {
  const samples = readPcm16Mono16kWav(FIXTURE_PATH);
  const turn: TurnCapture & { audioEndedAtMs: number } = {
    speechEndedAtMs: 0,
    firstAudioAtMs: 0,
    firstAgentAtMs: 0,
    agentReply: "",
    audioBytes: 0,
    error: "",
    audioEndedAtMs: 0,
  };

  const dispose = captureTurn(socket, turn);
  await sendPcmFrames(socket, samples, "turn-1");
  turn.audioEndedAtMs = Date.now();
  await sendSilence(socket, "turn-1", TRAILING_SILENCE_MS);
  await waitForTurnComplete(turn);
  await sleep(POST_TTS_DRAIN_MS);
  dispose();
  return turn;
}

function captureTurn(socket: WebSocket, turn: TurnCapture): () => void {
  let nextBinaryBelongsToTurn = false;
  const onMessage = (data: RawData, isBinary: boolean): void => {
    if (isBinary) {
      if (!nextBinaryBelongsToTurn) return;
      nextBinaryBelongsToTurn = false;
      if (turn.firstAudioAtMs === 0) turn.firstAudioAtMs = Date.now();
      turn.audioBytes += rawBytes(data).byteLength;
      return;
    }

    const msg = JSON.parse(data.toString()) as Record<string, unknown>;
    if (msg["type"] === "speech_ended") {
      turn.speechEndedAtMs = Date.now();
      return;
    }
    if (msg["type"] === "agent_chunk") {
      if (turn.firstAgentAtMs === 0) turn.firstAgentAtMs = Date.now();
      turn.agentReply += String(msg["text"] ?? "");
      return;
    }
    if (msg["type"] === "tts_chunk") {
      nextBinaryBelongsToTurn = true;
      return;
    }
    if (msg["type"] === "error") {
      turn.error = `websocket error: ${String(msg["component"])} ${String(msg["message"])}`;
    }
  };
  socket.on("message", onMessage);
  return () => socket.off("message", onMessage);
}

async function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  const ready = waitForJson(socket, (msg) => msg.type === "ready", 10_000);
  await new Promise<void>((resolveOpen, reject) => {
    socket.once("open", resolveOpen);
    socket.once("error", reject);
  });
  await ready;
  return socket;
}

async function sendPcmFrames(socket: WebSocket, samples: Int16Array, contextId: string): Promise<void> {
  for (let offset = 0; offset < samples.length; offset += FRAME_SAMPLES) {
    const end = Math.min(offset + FRAME_SAMPLES, samples.length);
    const frame = new Int16Array(FRAME_SAMPLES);
    frame.set(samples.subarray(offset, end));
    sendAudioFrame(socket, frame, contextId);
    await sleep(20);
  }
}

async function sendSilence(socket: WebSocket, contextId: string, durationMs: number): Promise<void> {
  const frames = Math.ceil(durationMs / 20);
  for (let i = 0; i < frames; i += 1) {
    sendAudioFrame(socket, new Int16Array(FRAME_SAMPLES), contextId);
    await sleep(20);
  }
}

function sendAudioFrame(socket: WebSocket, frame: Int16Array, contextId: string): void {
  socket.send(JSON.stringify({
    type: "audio",
    contextId,
    sampleRateHz: INPUT_SAMPLE_RATE,
    audio: Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength).toString("base64"),
  }));
}

async function waitForTurnComplete(turn: TurnCapture): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    if (turn.error) throw new Error(turn.error);
    if (turn.speechEndedAtMs > 0 && turn.firstAgentAtMs > 0 && turn.firstAudioAtMs > 0) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`turn timeout: speechEnded=${String(turn.speechEndedAtMs > 0)} audio=${String(turn.firstAudioAtMs > 0)}`);
}

async function waitForJson(
  socket: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket ready timeout")), timeoutMs);
    const onMessage = (data: RawData): void => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      if (!predicate(msg)) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(msg);
    };
    socket.on("message", onMessage);
  });
}

function rawBytes(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { evaluateLatencyFillerSmoke as evaluateSmoke, main };
