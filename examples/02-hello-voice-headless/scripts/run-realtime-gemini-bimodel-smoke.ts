// SPDX-License-Identifier: MIT
//
// Live bi-model gate: Gemini Live front delegates to kuralle agent via ask_university.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Route,
  VoiceAgentSession,
  type LlmToolCallPacket,
  type LlmToolResultPacket,
  type SttResultPacket,
  type TextToSpeechAudioPacket,
  type TextToSpeechEndPacket,
} from "@kuralle-syrinx/core";
import { fromKuralleRuntime, type KuralleRuntimeLike } from "@kuralle-syrinx/kuralle";
import { RealtimeBridge, fromGeminiLive } from "@kuralle-syrinx/realtime";
import type { RealtimeAdapter, RealtimeEvent, RealtimeToolDef } from "@kuralle-syrinx/realtime";

import { DEFAULT_VOICE_ID, ensureRepoRootDotenv, readPcm16Mono16kWav } from "../src/run-one-turn.js";
import { createFullUniversityRuntime } from "../src/university-agent-full.js";

const require = createRequire(import.meta.url);
const WebSocket = require("ws") as typeof import("ws").default;
const { WaveFile } = require("wavefile") as typeof import("wavefile");

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const FIXTURE_PATH = join(PKG_ROOT, "test", "fixtures", "university-cs-masters-deadline.wav");
const OUTPUT_DIR = join(PKG_ROOT, "test", "performance", "runs", "realtime-gemini-bimodel-smoke");
const INPUT_SAMPLE_RATE_HZ = 16_000;
const FRAME_SAMPLES = 320;
const GEMINI_LIVE_MODEL = "gemini-3.1-flash-live-preview";

const INPUT_TEXT =
  "What's the application deadline for the computer science masters?";

const ASK_UNIVERSITY_TOOL: RealtimeToolDef = {
  name: "ask_university",
  description: "Answer university student-relations questions (enrollment, add/drop, advising).",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

interface TimelineEntry {
  readonly atMs: number;
  readonly event: string;
  readonly detail?: string;
}

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

function containsMarch31(text: string): boolean {
  return /march\s*31/i.test(text);
}

function teeRealtimeAdapter(
  inner: RealtimeAdapter,
  onEvent: (ev: RealtimeEvent) => void,
): RealtimeAdapter {
  return {
    caps: inner.caps,
    open: (signal) => inner.open(signal),
    sendAudio: (pcm16) => inner.sendAudio(pcm16),
    cancelResponse: (audioEndMs) => inner.cancelResponse(audioEndMs),
    injectToolResult: (toolId, text) => inner.injectToolResult(toolId, text),
    close: () => inner.close(),
    events: teeEvents(inner.events, onEvent),
  };
}

async function* teeEvents(
  source: AsyncIterable<RealtimeEvent>,
  onEvent: (ev: RealtimeEvent) => void,
): AsyncGenerator<RealtimeEvent> {
  for await (const ev of source) {
    onEvent(ev);
    yield ev;
  }
}

async function synthesizeInputFixture(): Promise<void> {
  if (existsSync(FIXTURE_PATH)) return;

  const apiKey = process.env["CARTESIA_API_KEY"]?.trim();
  if (!apiKey) throw new Error("CARTESIA_API_KEY is required to synthesize university-cs-masters-deadline.wav");

  const chunks = await new Promise<Uint8Array[]>((resolve, reject) => {
    const ws = new WebSocket(
      "wss://api.cartesia.ai/tts/websocket?cartesia_version=2024-06-10",
      { headers: { "X-API-Key": apiKey } },
    );
    const audioChunks: Uint8Array[] = [];
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Cartesia input fixture synthesis timeout"));
    }, 30_000);

    ws.on("open", () => {
      ws.send(JSON.stringify({
        model_id: "sonic-3",
        transcript: INPUT_TEXT,
        voice: { mode: "id", id: process.env["CARTESIA_VOICE_ID"]?.trim() ?? DEFAULT_VOICE_ID },
        output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: 16000 },
        language: "en",
        context_id: randomUUID(),
      }));
    });
    ws.on("message", (data: { toString(): string }) => {
      const msg = JSON.parse(data.toString());
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

  const samples = new Int16Array(merged.buffer, merged.byteOffset, Math.floor(merged.byteLength / 2));
  const wav = new WaveFile();
  wav.fromScratch(1, 16000, "16", samples);

  await mkdir(dirname(FIXTURE_PATH), { recursive: true });
  await writeFile(FIXTURE_PATH, Buffer.from(wav.toBuffer()));
}

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  const apiKey = process.env["GEMINI_API_KEY"]?.trim();
  if (!apiKey) throw new Error("missing GEMINI_API_KEY in repo-root .env");

  await synthesizeInputFixture();
  await mkdir(OUTPUT_DIR, { recursive: true });

  const timeline: TimelineEntry[] = [];
  const startedAt = Date.now();
  const pushTimeline = (event: string, detail?: string): void => {
    timeline.push({ atMs: Date.now() - startedAt, event, detail });
  };

  let assistantTranscript = "";
  const baseAdapter = fromGeminiLive({
    apiKey,
    model: GEMINI_LIVE_MODEL,
    tools: [ASK_UNIVERSITY_TOOL],
  });
  const adapter = teeRealtimeAdapter(baseAdapter, (ev) => {
    if (ev.type === "tool_call") {
      pushTimeline("adapter.tool_call", JSON.stringify({ toolName: ev.toolName, args: ev.args }));
    }
    if (ev.type === "transcript" && ev.role === "assistant" && ev.final) {
      assistantTranscript = assistantTranscript
        ? `${assistantTranscript} ${ev.text}`.trim()
        : ev.text.trim();
      pushTimeline("adapter.assistant_transcript.final", ev.text);
    }
    if (ev.type === "error") {
      pushTimeline("adapter.error", ev.cause.message);
    }
  });

  const { runtime } = await createFullUniversityRuntime();
  const universityReasoner = fromKuralleRuntime(runtime as unknown as KuralleRuntimeLike, {
    sessionId: `gemini-bimodel-${Math.random()}`,
    userId: "bimodel",
  });

  const bridge = new RealtimeBridge(adapter, universityReasoner, ASK_UNIVERSITY_TOOL.name);

  const session = new VoiceAgentSession({
    plugins: { realtime: {} },
    endpointingOwner: "timer",
  });
  session.registerPlugin("realtime", bridge);

  const outputChunks: Uint8Array[] = [];
  let userTranscript = "";
  let reasonerAnswer = "";
  let sawToolCall = false;
  let sawToolResult = false;
  let sawFirstTtsAudio = false;

  session.bus.on<LlmToolCallPacket>("llm.tool_call", (pkt) => {
    sawToolCall = true;
    pushTimeline("bus.llm.tool_call", JSON.stringify({ toolName: pkt.toolName, toolArgs: pkt.toolArgs }));
  });
  session.bus.on<LlmToolResultPacket>("llm.tool_result", (pkt) => {
    sawToolResult = true;
    reasonerAnswer = pkt.result;
    pushTimeline("bus.llm.tool_result", pkt.result);
  });
  session.bus.on<SttResultPacket>("stt.result", (pkt) => {
    userTranscript = pkt.text;
    pushTimeline("bus.stt.result", pkt.text);
  });
  session.bus.on<TextToSpeechAudioPacket>("tts.audio", (pkt) => {
    if (!sawFirstTtsAudio) {
      sawFirstTtsAudio = true;
      pushTimeline("bus.tts.audio");
    }
    outputChunks.push(pkt.audio);
  });

  const completion = new Promise<void>((resolve, reject) => {
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const hardTimeout = setTimeout(() => {
      reject(new Error("realtime gemini bimodel smoke timeout"));
    }, 180_000);

    const maybeSettle = (): void => {
      if (!sawToolResult) return;
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        clearTimeout(hardTimeout);
        resolve();
      }, 8000);
    };

    session.bus.on<TextToSpeechEndPacket>("tts.end", () => {
      pushTimeline("bus.tts.end");
      maybeSettle();
    });
  });

  await session.start();

  const pcm = readPcm16Mono16kWav(FIXTURE_PATH);
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

  pushTimeline("user.audio.done");

  await completion;

  if (!sawToolCall) throw new Error("ask_university tool_call was not observed");
  if (!sawToolResult) throw new Error("delegate llm.tool_result was not observed");
  if (!isNonSilentAudio(outputChunks)) throw new Error("captured assistant audio is silent");

  const groundedText = `${reasonerAnswer} ${assistantTranscript}`.trim();
  if (!containsMarch31(groundedText)) {
    throw new Error(`grounded answer missing "March 31": reasoner="${reasonerAnswer}" assistant="${assistantTranscript}"`);
  }

  const outPath = join(OUTPUT_DIR, "audio-out.wav");
  await writePcm16Wav(outPath, outputChunks, INPUT_SAMPLE_RATE_HZ);

  const pass =
    sawToolCall &&
    sawToolResult &&
    isNonSilentAudio(outputChunks) &&
    containsMarch31(groundedText);

  console.log(`\n=== GEMINI BI-MODEL PASS: ${pass ? "YES" : "NO"} ===`);
  console.log(`model: ${GEMINI_LIVE_MODEL}`);
  console.log(`grounded answer (reasoner): ${reasonerAnswer}`);
  console.log(`assistant transcript (voiced): ${assistantTranscript}`);

  const summary = {
    ok: pass,
    model: GEMINI_LIVE_MODEL,
    userTranscript,
    reasonerAnswer,
    assistantTranscript,
    audioBytes: mergeBytes(outputChunks).byteLength,
    outPath,
    timeline,
  };

  console.log(JSON.stringify(summary, null, 2));

  await session.close();
  await adapter.close();
  process.exit(0);
}

main().catch(async (err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
