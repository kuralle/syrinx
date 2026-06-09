// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import WebSocket from "ws";
import { Route, type TextToSpeechAudioPacket, type TextToSpeechEndPacket } from "@kuralle-syrinx/core";

import {
  DEFAULT_VOICE_ID,
  coerceGoogleGenAiKey,
  ensureRepoRootDotenv,
  listMissingVoiceHeadlessEnvKeys,
} from "../src/run-one-turn.js";
import { createUniversitySupportKuralleSession } from "../src/university-support-kuralle.js";

const require = createRequire(import.meta.url);
const { WaveFile } = require("wavefile") as typeof import("wavefile");

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const RUNS_DIR = join(PKG_ROOT, "test", "performance", "runs");
const INPUT_SAMPLE_RATE_HZ = 16_000;
const FRAME_SAMPLES = 320;
const POST_USER_SILENCE_MS = 5000;
const POST_TTS_DRAIN_MS = 500;

const TURN1_TEXT = "My name is Priya and I'm applying for the computer science masters.";
const TURN2_TEXT = "What's my name and which program did I say?";

interface TurnCapture {
  readonly id: string;
  readonly inputText: string;
  sttTranscript: string;
  agentReply: string;
  sttFinalAtMs: number;
  firstAgentAtMs: number;
  ttsEndedAtMs: number;
  error: string;
}

async function synthesizeFixture(transcript: string): Promise<Int16Array> {
  const apiKey = process.env["CARTESIA_API_KEY"]?.trim();
  if (!apiKey) throw new Error("CARTESIA_API_KEY is required");

  const chunks = await new Promise<Uint8Array[]>((resolve, reject) => {
    const ws = new WebSocket(
      "wss://api.cartesia.ai/tts/websocket?cartesia_version=2024-06-10",
      { headers: { "X-API-Key": apiKey } },
    );
    const audioChunks: Uint8Array[] = [];
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Cartesia fixture synthesis timeout"));
    }, 30_000);

    ws.on("open", () => {
      ws.send(JSON.stringify({
        model_id: "sonic-3",
        transcript,
        voice: { mode: "id", id: process.env["CARTESIA_VOICE_ID"]?.trim() ?? DEFAULT_VOICE_ID },
        output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: 16000 },
        language: "en",
        context_id: randomUUID(),
      }));
    });
    ws.on("message", (data: WebSocket.RawData) => {
      const msg = JSON.parse(data.toString()) as { data?: string; done?: boolean };
      if (msg.data) audioChunks.push(new Uint8Array(Buffer.from(msg.data, "base64")));
      if (msg.done) {
        clearTimeout(timeout);
        ws.close();
        resolve(audioChunks);
      }
    });
    ws.on("error", (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Int16Array(merged.buffer, merged.byteOffset, Math.floor(merged.byteLength / 2));
}

function pcmToBytes(samples: Readonly<Int16Array>): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function captureTurn(
  session: ReturnType<typeof createUniversitySupportKuralleSession>,
  turn: TurnCapture,
): () => void {
  const offStt = session.bus.on("stt.result", (pkt) => {
    const stt = pkt as unknown as { contextId: string; text: string; timestampMs: number };
    if (stt.contextId !== turn.id || turn.sttFinalAtMs > 0) return;
    turn.sttTranscript = stt.text;
    turn.sttFinalAtMs = stt.timestampMs;
  });
  const offTtsEnd = session.bus.on<TextToSpeechEndPacket>("tts.end", (pkt) => {
    if (pkt.contextId === turn.id) turn.ttsEndedAtMs = pkt.timestampMs;
  });
  const onAgentDelta = (event: { tsMs: number; turnId: string; delta: string }) => {
    if (event.turnId !== turn.id) return;
    if (turn.firstAgentAtMs === 0) turn.firstAgentAtMs = event.tsMs;
    turn.agentReply += event.delta;
  };
  const onError = (event: { stage: string; category: string; message: string }) => {
    turn.error = `${event.stage}/${event.category}: ${event.message}`;
  };
  session.on("agent_text_delta", onAgentDelta);
  session.on("error", onError);
  return () => {
    offStt();
    offTtsEnd();
    session.off("agent_text_delta", onAgentDelta);
    session.off("error", onError);
  };
}

async function sendPcmFrames(
  session: ReturnType<typeof createUniversitySupportKuralleSession>,
  samples: Int16Array,
  contextId: string,
): Promise<void> {
  for (let offset = 0; offset < samples.length; offset += FRAME_SAMPLES) {
    const frame = new Int16Array(FRAME_SAMPLES);
    frame.set(samples.subarray(offset, Math.min(samples.length, offset + FRAME_SAMPLES)));
    session.bus.push(Route.Main, {
      kind: "user.audio_received",
      contextId,
      timestampMs: Date.now(),
      audio: pcmToBytes(frame),
    });
    await sleep(20);
  }
}

async function sendSilence(
  session: ReturnType<typeof createUniversitySupportKuralleSession>,
  contextId: string,
  durationMs: number,
): Promise<void> {
  const frames = Math.ceil(durationMs / 20);
  for (let i = 0; i < frames; i += 1) {
    session.bus.push(Route.Main, {
      kind: "user.audio_received",
      contextId,
      timestampMs: Date.now(),
      audio: pcmToBytes(new Int16Array(FRAME_SAMPLES)),
    });
    await sleep(20);
  }
}

async function waitForTurnComplete(turn: TurnCapture): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    if (turn.error) throw new Error(turn.error);
    if (turn.sttFinalAtMs > 0 && turn.firstAgentAtMs > 0 && turn.ttsEndedAtMs > 0) return;
    await sleep(100);
  }
  throw new Error(
    `turn timeout: ${turn.id}; stt=${String(turn.sttFinalAtMs > 0)} ` +
      `agent=${String(turn.firstAgentAtMs > 0)} ttsEnd=${String(turn.ttsEndedAtMs > 0)}`,
  );
}

async function runTurn(
  session: ReturnType<typeof createUniversitySupportKuralleSession>,
  id: string,
  inputText: string,
  samples: Int16Array,
  previousContextId: string,
): Promise<TurnCapture> {
  const turn: TurnCapture = {
    id,
    inputText,
    sttTranscript: "",
    agentReply: "",
    sttFinalAtMs: 0,
    firstAgentAtMs: 0,
    ttsEndedAtMs: 0,
    error: "",
  };
  const dispose = captureTurn(session, turn);
  session.bus.push(Route.Main, {
    kind: "turn.change",
    contextId: turn.id,
    previousContextId,
    reason: "kuralle_memory_smoke",
    timestampMs: Date.now(),
  });
  await sendPcmFrames(session, samples, turn.id);
  await sendSilence(session, turn.id, POST_USER_SILENCE_MS);
  await waitForTurnComplete(turn);
  await sleep(POST_TTS_DRAIN_MS);
  dispose();
  return turn;
}

function llmTtftMs(turn: TurnCapture): number {
  return turn.sttFinalAtMs > 0 && turn.firstAgentAtMs > 0
    ? Math.max(0, turn.firstAgentAtMs - turn.sttFinalAtMs)
    : 0;
}

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  coerceGoogleGenAiKey();
  const missing = listMissingVoiceHeadlessEnvKeys();
  if (missing.length > 0) throw new Error(`missing live provider env: ${missing.join(", ")}`);

  const runId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  await mkdir(join(RUNS_DIR, `kuralle-memory-${runId}`), { recursive: true });

  const [turn1Samples, turn2Samples] = await Promise.all([
    synthesizeFixture(TURN1_TEXT),
    synthesizeFixture(TURN2_TEXT),
  ]);

  const sessionId = "kuralle-memory-smoke-session";
  const userId = "priya-smoke-user";
  const session = createUniversitySupportKuralleSession({
    inputSampleRate: INPUT_SAMPLE_RATE_HZ,
    profile: "interactive",
    ttsProvider: "cartesia",
    sessionId,
    userId,
  });

  await session.start();
  let turn1: TurnCapture;
  let turn2: TurnCapture;
  try {
    turn1 = await runTurn(session, "turn-01", TURN1_TEXT, turn1Samples, "");
    turn2 = await runTurn(session, "turn-02", TURN2_TEXT, turn2Samples, turn1.id);
  } finally {
    await session.close();
  }

  const reply2 = turn2.agentReply.toLowerCase();
  const recallsName = reply2.includes("priya");
  const recallsProgram = reply2.includes("computer science");
  const passed = recallsName && recallsProgram;

  console.log(`turn-1 transcript: ${turn1.sttTranscript}`);
  console.log(`turn-1 agent reply: ${turn1.agentReply}`);
  console.log(`turn-1 LLM-TTFT: ${String(llmTtftMs(turn1))}ms`);
  console.log(`turn-2 transcript: ${turn2.sttTranscript}`);
  console.log(`turn-2 agent reply: ${turn2.agentReply}`);
  console.log(`turn-2 LLM-TTFT: ${String(llmTtftMs(turn2))}ms`);
  console.log(`sessionId: ${sessionId}`);
  console.log(passed ? "PASS: turn-2 recalled name and program from kuralle session memory" : "FAIL: turn-2 did not recall name and program");

  if (!passed) {
    const reasons: string[] = [];
    if (!recallsName) reasons.push('missing "priya"');
    if (!recallsProgram) reasons.push('missing "computer science"');
    throw new Error(`kuralle memory smoke failed: ${reasons.join("; ")}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
