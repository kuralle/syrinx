// SPDX-License-Identifier: MIT
//
// Live multi-turn gate: Gemini Live front + kuralle back — session memory recall across turns.

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";
import {
  Route,
  VoiceAgentSession,
  type LlmResponseDonePacket,
  type LlmToolResultPacket,
  type SttResultPacket,
  type TextToSpeechAudioPacket,
  type TextToSpeechEndPacket,
} from "@kuralle-syrinx/core";
import { fromKuralleRuntime, type KuralleRuntimeLike } from "@kuralle-syrinx/kuralle";
import { RealtimeBridge, fromGeminiLive } from "@kuralle-syrinx/realtime";
import type { RealtimeToolDef } from "@kuralle-syrinx/realtime";

import { DEFAULT_VOICE_ID, ensureRepoRootDotenv } from "../src/run-one-turn.js";
import { createFullUniversityRuntime } from "../src/university-agent-full.js";

const require = createRequire(import.meta.url);
const { WaveFile } = require("wavefile") as typeof import("wavefile");

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const OUTPUT_DIR = join(PKG_ROOT, "test", "performance", "runs", "realtime-gemini-multiturn-smoke");
const INPUT_SAMPLE_RATE_HZ = 16_000;
const FRAME_SAMPLES = 320;
const GEMINI_LIVE_MODEL = "gemini-3.1-flash-live-preview";
const POST_TURN_SILENCE_MS = 5000;

const TURN1_TEXT = "My name is Priya and I'm applying for the computer science masters.";
const TURN2_TEXT = "What's my name and which program did I say?";

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function synthesizeFixture(transcript: string): Promise<Int16Array> {
  // Deepgram Aura TTS (REST, linear16 16k). Cartesia was the original source but is 402/out of credits.
  const apiKey = process.env["DEEPGRAM_API_KEY"]?.trim();
  if (!apiKey) throw new Error("DEEPGRAM_API_KEY is required to synthesize multiturn fixtures");
  const res = await fetch(
    "https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=linear16&sample_rate=16000",
    {
      method: "POST",
      headers: { Authorization: `Token ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ text: transcript }),
    },
  );
  if (!res.ok) throw new Error(`Deepgram TTS ${res.status}: ${await res.text()}`);
  const merged = new Uint8Array(await res.arrayBuffer());
  return new Int16Array(merged.buffer, merged.byteOffset, Math.floor(merged.byteLength / 2));
}

async function streamPcm(
  session: VoiceAgentSession,
  pcm: Int16Array,
  transportContextId: string,
): Promise<void> {
  for (let offset = 0; offset < pcm.length; offset += FRAME_SAMPLES) {
    const frame = new Int16Array(FRAME_SAMPLES);
    frame.set(pcm.subarray(offset, Math.min(pcm.length, offset + FRAME_SAMPLES)));
    session.bus.push(Route.Main, {
      kind: "user.audio_received",
      contextId: transportContextId,
      timestampMs: Date.now(),
      audio: pcmToBytes(frame),
    });
    await sleep(20);
  }
}

async function streamSilence(
  session: VoiceAgentSession,
  transportContextId: string,
  durationMs: number,
): Promise<void> {
  const frames = Math.ceil(durationMs / 20);
  for (let i = 0; i < frames; i += 1) {
    session.bus.push(Route.Main, {
      kind: "user.audio_received",
      contextId: transportContextId,
      timestampMs: Date.now(),
      audio: pcmToBytes(new Int16Array(FRAME_SAMPLES)),
    });
    await sleep(20);
  }
}

async function waitForTtsEnd(session: VoiceAgentSession, afterCount: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let seen = 0;
    const timeout = setTimeout(() => reject(new Error("turn tts.end timeout")), 180_000);
    const off = session.bus.on<TextToSpeechEndPacket>("tts.end", (pkt) => {
      seen += 1;
      if (seen > afterCount) {
        clearTimeout(timeout);
        off();
        resolve(pkt.contextId);
      }
    });
  });
}

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  const apiKey = process.env["GEMINI_API_KEY"]?.trim();
  if (!apiKey) throw new Error("missing GEMINI_API_KEY in repo-root .env");

  await mkdir(OUTPUT_DIR, { recursive: true });

  const [turn1Pcm, turn2Pcm] = await Promise.all([
    synthesizeFixture(TURN1_TEXT),
    synthesizeFixture(TURN2_TEXT),
  ]);

  const sessionId = "gemini-multiturn-smoke-session";
  const adapter = fromGeminiLive({
    apiKey,
    model: GEMINI_LIVE_MODEL,
    tools: [ASK_UNIVERSITY_TOOL],
  });

  const { runtime } = await createFullUniversityRuntime();
  const universityReasoner = fromKuralleRuntime(runtime as unknown as KuralleRuntimeLike, {
    sessionId,
    userId: "priya-smoke-user",
  });

  const bridge = new RealtimeBridge(adapter, universityReasoner, ASK_UNIVERSITY_TOOL.name);

  const session = new VoiceAgentSession({
    plugins: { realtime: {} },
    endpointingOwner: "timer",
  });
  session.registerPlugin("realtime", bridge);

  const transportContextId = crypto.randomUUID();
  const audioByTurn = new Map<string, Uint8Array[]>();
  const userTranscripts: string[] = [];
  const assistantByContext = new Map<string, string>();
  const reasonerAnswers: string[] = [];

  session.bus.on<SttResultPacket>("stt.result", (pkt) => {
    userTranscripts.push(pkt.text);
  });
  session.bus.on<LlmResponseDonePacket>("llm.done", (pkt) => {
    assistantByContext.set(pkt.contextId, pkt.text);
  });
  session.bus.on<LlmToolResultPacket>("llm.tool_result", (pkt) => {
    reasonerAnswers.push(pkt.result);
  });
  session.bus.on<TextToSpeechAudioPacket>("tts.audio", (pkt) => {
    const list = audioByTurn.get(pkt.contextId) ?? [];
    list.push(pkt.audio);
    audioByTurn.set(pkt.contextId, list);
  });

  await session.start();

  await streamPcm(session, turn1Pcm, transportContextId);
  await streamSilence(session, transportContextId, POST_TURN_SILENCE_MS);
  const turn1Context = await waitForTtsEnd(session, 0);

  await streamPcm(session, turn2Pcm, transportContextId);
  await streamSilence(session, transportContextId, POST_TURN_SILENCE_MS);
  const turn2Context = await waitForTtsEnd(session, 1);

  const turn2Chunks = audioByTurn.get(turn2Context) ?? [];
  const assistantTurn2 = assistantByContext.get(turn2Context) ?? "";
  const recallText = `${assistantTurn2} ${reasonerAnswers.join(" ")}`.toLowerCase();
  const recallsName = recallText.includes("priya");
  const recallsProgram = recallText.includes("computer science");

  if (!recallsName || !recallsProgram) {
    throw new Error(
      `turn-2 recall failed: recallsName=${recallsName} recallsProgram=${recallsProgram} ` +
        `turn1Context=${turn1Context} turn2Context=${turn2Context} ` +
        `userTranscripts=${JSON.stringify(userTranscripts)} ` +
        `assistantTurn2="${assistantTurn2}" reasonerAnswers=${JSON.stringify(reasonerAnswers)}`,
    );
  }

  const outTurn1 = join(OUTPUT_DIR, "turn1.wav");
  const outTurn2 = join(OUTPUT_DIR, "turn2.wav");
  await writePcm16Wav(outTurn1, audioByTurn.get(turn1Context) ?? [], INPUT_SAMPLE_RATE_HZ);
  await writePcm16Wav(outTurn2, turn2Chunks, INPUT_SAMPLE_RATE_HZ);

  console.log(
    JSON.stringify({
      ok: true,
      model: GEMINI_LIVE_MODEL,
      sessionId,
      turn1Context,
      turn2Context,
      userTranscripts,
      assistantTurn2,
      reasonerAnswers,
      recallsName,
      recallsProgram,
      outTurn1,
      outTurn2,
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
