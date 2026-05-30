// SPDX-License-Identifier: MIT

import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import WebSocket, { type RawData } from "ws";

import { decodeSyrinxAudioEnvelope, hasSyrinxAudioEnvelope } from "@asyncdot/voice";
import { createVoiceWebSocketServer } from "@asyncdot/voice-server-websocket";

import {
  GEMINI_UNIVERSITY_FIXTURES,
  PKG_ROOT,
  ensureGeminiUniversityFixtures,
} from "./generate-gemini-university-fixtures.js";
import {
  DEFAULT_MODEL,
  coerceGoogleGenAiKey,
  ensureRepoRootDotenv,
  readPcm16Mono16kWav,
} from "../src/run-one-turn.js";
import { createUniversitySupportSession } from "../src/university-support-agent.js";
import { pcm16DurationMs, writeSmokeArtifactManifest, type SmokeArtifactManifest } from "./smoke-artifact-manifest.js";

const require = createRequire(import.meta.url);
const { WaveFile } = require("wavefile") as typeof import("wavefile");

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = join(SCRIPT_DIR, "..", "test", "performance", "runs");
const BASELINE_PATH = join(SCRIPT_DIR, "..", "test", "performance", "websocket-university-multiturn-baseline.json");
const INPUT_SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 320;
const MIN_MODELED_CONVERSATION_MS = 480_000;
const POST_TTS_DRAIN_MS = 500;

interface TurnCapture {
  readonly id: string;
  readonly fixtureId: string;
  readonly inputText: string;
  inputAudioMs: number;
  startedAtMs: number;
  speechStartedAtMs: number;
  speechStartedCount: number;
  audioEndedAtMs: number;
  speechEndedAtMs: number;
  speechEndedCount: number;
  sttFinalAtMs: number;
  firstAgentAtMs: number;
  firstAudioAtMs: number;
  agentEndedAtMs: number;
  ttsEndedAtMs: number;
  transcript: string;
  agentReply: string;
  toolCalls: string[];
  audioChunks: Uint8Array[];
  error: string;
}

interface ConversationEvaluation {
  readonly failures: string[];
  readonly diagnostics: string[];
}

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  coerceGoogleGenAiKey();
  if (!process.env["DEEPGRAM_API_KEY"]?.trim()) throw new Error("DEEPGRAM_API_KEY is required");
  if (!process.env["GOOGLE_GENERATIVE_AI_API_KEY"]?.trim()) {
    throw new Error("GOOGLE_GENERATIVE_AI_API_KEY or GEMINI_API_KEY is required");
  }

  await ensureGeminiUniversityFixtures();

  const runId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const runDir = join(RUNS_DIR, `websocket-university-${runId}`);
  const outputDir = join(runDir, "assistant-audio");
  await mkdir(outputDir, { recursive: true });

  const session = createSession();
  const server = await createVoiceWebSocketServer({
    port: 0,
    createSession: () => session,
    contextId: () => "ws-university-bootstrap",
  });

  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP websocket address");
    const socket = await openSocket(`ws://127.0.0.1:${address.port}/ws`);
    const turns = await runConversation(socket, outputDir);
    socket.close();

    const totalInputAudioMs = turns.reduce((sum, turn) => sum + turn.inputAudioMs, 0);
    const totalAssistantAudioMs = turns.reduce((sum, turn) => sum + assistantAudioMs(turn), 0);
    const modeledConversationMs = totalInputAudioMs + totalAssistantAudioMs;
    const evaluation = evaluateConversation(turns, modeledConversationMs);
    const { failures, diagnostics } = evaluation;
    const manifestPath = join(runDir, "manifest.json");
    const baseline = {
      scenario: "websocket_university_student_relations_multiturn",
      generatedAt: new Date().toISOString(),
      fixtureProvider: "gemini-tts",
      llmModel: process.env["SYRINX_LLM_MODEL"]?.trim() || DEFAULT_MODEL,
      ttsModel: process.env["SYRINX_GEMINI_TTS_MODEL"]?.trim() || "gemini-2.5-flash-preview-tts",
      transport: "websocket",
      inputSampleRateHz: INPUT_SAMPLE_RATE,
      outputSampleRateHz: 24000,
      postTtsDrainMs: POST_TTS_DRAIN_MS,
      turnCount: turns.length,
      modeledConversationMs,
      latencyMs: {
        totalInputAudio: totalInputAudioMs,
        totalAssistantAudio: totalAssistantAudioMs,
        avgSttFinalAfterSpeechEnd: average(turns.map((turn) => turn.sttFinalAtMs - turn.audioEndedAtMs)),
        avgVadSpeechEndAfterAudioEnd: average(turns.map((turn) => turn.speechEndedAtMs - turn.audioEndedAtMs)),
        avgLlmTimeToFirstText: average(turns.map((turn) => turn.firstAgentAtMs - turn.sttFinalAtMs)),
        avgTtsTimeToFirstAudio: average(turns.map((turn) => turn.firstAudioAtMs - turn.agentEndedAtMs)),
        avgSpeechEndToFirstAssistantAudio: average(turns.map((turn) => turn.firstAudioAtMs - turn.audioEndedAtMs)),
        avgVadSpeechEndToFirstAssistantAudio: average(turns.map((turn) => turn.firstAudioAtMs - turn.speechEndedAtMs)),
      },
      turns: turns.map((turn) => ({
        id: turn.id,
        fixtureId: turn.fixtureId,
        inputText: turn.inputText,
        sttFinal: turn.transcript,
        agentReply: turn.agentReply,
        toolCalls: turn.toolCalls,
        inputAudioMs: turn.inputAudioMs,
        vadSpeechStartedCount: turn.speechStartedCount,
        vadSpeechEndedCount: turn.speechEndedCount,
        assistantAudioMs: assistantAudioMs(turn),
        latencyMs: {
          sttFinalAfterSpeechEnd: turn.sttFinalAtMs - turn.audioEndedAtMs,
          vadSpeechEndAfterAudioEnd: turn.speechEndedAtMs - turn.audioEndedAtMs,
          llmTimeToFirstText: turn.firstAgentAtMs - turn.sttFinalAtMs,
          ttsTimeToFirstAudio: turn.firstAudioAtMs - turn.agentEndedAtMs,
          speechEndToFirstAssistantAudio: turn.firstAudioAtMs - turn.audioEndedAtMs,
          vadSpeechEndToFirstAssistantAudio: turn.firstAudioAtMs - turn.speechEndedAtMs,
          turnWallClock: turn.ttsEndedAtMs - turn.startedAtMs,
        },
        assistantAudioPath: relative(PKG_ROOT, join(outputDir, `${turn.id}.wav`)),
      })),
      diagnostics,
      artifacts: {
        runDir: relative(PKG_ROOT, runDir),
        assistantAudioDir: relative(PKG_ROOT, outputDir),
        manifestPath: relative(PKG_ROOT, manifestPath),
      },
      qualityGate: {
        passed: failures.length === 0,
        failures,
      },
    };
    const manifest = buildSmokeManifest({
      generatedAt: baseline.generatedAt,
      runDir,
      outputDir,
      turns,
      failures,
    });

    await mkdir(dirname(BASELINE_PATH), { recursive: true });
    await writeFile(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
    await writeSmokeArtifactManifest(manifestPath, manifest);
    console.log(JSON.stringify(baseline, null, 2));
    if (failures.length > 0) throw new Error(`websocket university smoke failed: ${failures.join("; ")}`);
  } finally {
    await server.close();
  }
}

function buildSmokeManifest(args: {
  readonly generatedAt: string;
  readonly runDir: string;
  readonly outputDir: string;
  readonly turns: readonly TurnCapture[];
  readonly failures: readonly string[];
}): SmokeArtifactManifest {
  const turnArtifacts = args.turns.map((turn) => {
    const inputByteLength = Math.round((turn.inputAudioMs / 1000) * INPUT_SAMPLE_RATE * 2);
    const assistantByteLength = mergeBytes(turn.audioChunks).byteLength;
    return {
      id: turn.id,
      fixtureId: turn.fixtureId,
      inputAudio: {
        sampleRateHz: INPUT_SAMPLE_RATE,
        encoding: "pcm_s16le" as const,
        channels: 1 as const,
        byteLength: inputByteLength,
        durationMs: turn.inputAudioMs,
      },
      assistantAudio: {
        sampleRateHz: 24000,
        encoding: "pcm_s16le" as const,
        channels: 1 as const,
        byteLength: assistantByteLength,
        durationMs: pcm16DurationMs(assistantByteLength, 24000),
        path: relative(PKG_ROOT, join(args.outputDir, `${turn.id}.wav`)),
      },
      latencyMs: {
        sttFinalAfterSpeechEnd: turn.sttFinalAtMs - turn.audioEndedAtMs,
        vadSpeechEndAfterAudioEnd: turn.speechEndedAtMs - turn.audioEndedAtMs,
        llmTimeToFirstText: turn.firstAgentAtMs - turn.sttFinalAtMs,
        ttsTimeToFirstAudio: turn.firstAudioAtMs - turn.agentEndedAtMs,
        speechEndToFirstAssistantAudio: turn.firstAudioAtMs - turn.audioEndedAtMs,
        vadSpeechEndToFirstAssistantAudio: turn.firstAudioAtMs - turn.speechEndedAtMs,
        turnWallClock: turn.ttsEndedAtMs - turn.startedAtMs,
      },
      vad: {
        speechStartedCount: turn.speechStartedCount,
        speechEndedCount: turn.speechEndedCount,
      },
    };
  });
  const inputByteLength = turnArtifacts.reduce((sum, turn) => sum + turn.inputAudio.byteLength, 0);
  const outputByteLength = turnArtifacts.reduce((sum, turn) => sum + turn.assistantAudio.byteLength, 0);
  return {
    schemaVersion: 2,
    scenario: "websocket_university_student_relations_multiturn",
    generatedAt: args.generatedAt,
    transport: "websocket",
    fixtureProvider: "gemini-tts",
    run: {
      runDir: relative(PKG_ROOT, args.runDir),
      baselinePath: relative(PKG_ROOT, BASELINE_PATH),
    },
    audio: {
      inputSampleRateHz: INPUT_SAMPLE_RATE,
      outputSampleRateHz: 24000,
      inputByteLength,
      outputByteLength,
      inputWireByteLength: inputByteLength,
      outputWireByteLength: outputByteLength,
      inputDecodedPcmByteLength: inputByteLength,
      outputDecodedPcmByteLength: outputByteLength,
      inputDurationMs: pcm16DurationMs(inputByteLength, INPUT_SAMPLE_RATE),
      outputDurationMs: pcm16DurationMs(outputByteLength, 24000),
    },
    turns: turnArtifacts,
    qualityGate: {
      passed: args.failures.length === 0,
      failures: args.failures,
    },
  };
}

function createSession() {
  const session = createUniversitySupportSession({
    inputSampleRate: INPUT_SAMPLE_RATE,
    profile: "longform",
    ttsProvider: "gemini",
  });
  if (process.env["SYRINX_WS_DEBUG"] === "1") {
    session.bus.on("eos.turn_complete", (pkt) => {
      const eos = pkt as unknown as { contextId: string; text: string };
      console.log(`[debug] eos ${eos.contextId}: ${eos.text.slice(0, 80)}`);
    });
    session.bus.on("llm.tool_call", (pkt) => {
      const call = pkt as unknown as { contextId: string; toolName: string };
      console.log(`[debug] tool ${call.contextId}: ${call.toolName}`);
    });
    session.bus.on("llm.delta", (pkt) => {
      const delta = pkt as unknown as { contextId: string; text: string };
      console.log(`[debug] llm ${delta.contextId}: ${delta.text.slice(0, 80)}`);
    });
    session.bus.on("llm.error", (pkt) => {
      const err = pkt as unknown as { contextId: string; cause: Error };
      console.log(`[debug] llm-error ${err.contextId}: ${err.cause.message}`);
    });
  }
  return session;
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

async function runConversation(socket: WebSocket, outputDir: string): Promise<TurnCapture[]> {
  const turns: TurnCapture[] = [];
  const maxTurns = Number.parseInt(process.env["SYRINX_WS_MAX_TURNS"] ?? "", 10);
  const fixtures = Number.isFinite(maxTurns) && maxTurns > 0
    ? GEMINI_UNIVERSITY_FIXTURES.slice(0, maxTurns)
    : GEMINI_UNIVERSITY_FIXTURES;
  for (let index = 0; index < fixtures.length; index += 1) {
    const fixture = fixtures[index]!;
    const samples = readPcm16Mono16kWav(fixture.path);

    const turn: TurnCapture = {
      id: `turn-${String(index + 1).padStart(2, "0")}`,
      fixtureId: fixture.id,
      inputText: fixture.text,
      inputAudioMs: Math.round((samples.length / INPUT_SAMPLE_RATE) * 1000),
      startedAtMs: Date.now(),
      speechStartedAtMs: 0,
      speechStartedCount: 0,
      audioEndedAtMs: 0,
      speechEndedAtMs: 0,
      speechEndedCount: 0,
      sttFinalAtMs: 0,
      firstAgentAtMs: 0,
      firstAudioAtMs: 0,
      agentEndedAtMs: 0,
      ttsEndedAtMs: 0,
      transcript: "",
      agentReply: "",
      toolCalls: [],
      audioChunks: [],
      error: "",
    };

    console.log(`starting ${turn.id} ${fixture.id} (${String(turn.inputAudioMs)}ms input)`);
    const dispose = captureTurn(socket, turn);
    await sendPcmFrames(socket, samples, turn.id);
    turn.audioEndedAtMs = Date.now();
    await sendSilence(socket, turn.id, 5000);
    await waitForTurnComplete(turn);
    await sleep(POST_TTS_DRAIN_MS);
    dispose();
    await writeTurnAudio(join(outputDir, `${turn.id}.wav`), turn.audioChunks);
    console.log(
      `completed ${turn.id}: stt=${String(turn.sttFinalAtMs - turn.audioEndedAtMs)}ms ` +
        `llm=${String(turn.firstAgentAtMs - turn.sttFinalAtMs)}ms ` +
        `tts=${String(turn.firstAudioAtMs - turn.firstAgentAtMs)}ms`,
    );
    turns.push(turn);
  }
  return turns;
}

function captureTurn(socket: WebSocket, turn: TurnCapture): () => void {
  let nextBinaryBelongsToTurn = false;
  const onMessage = (data: RawData, isBinary: boolean): void => {
    if (isBinary) {
      if (!nextBinaryBelongsToTurn) return;
      nextBinaryBelongsToTurn = false;
      if (turn.agentEndedAtMs === 0) return;
      if (turn.firstAudioAtMs === 0) turn.firstAudioAtMs = Date.now();
      turn.audioChunks.push(rawBytes(data));
      return;
    }

    const msg = JSON.parse(data.toString()) as Record<string, unknown>;
    if (typeof msg["turnId"] === "string" && msg["turnId"] !== turn.id) return;
    if (msg["type"] === "speech_started") {
      turn.speechStartedCount += 1;
      if (turn.speechStartedAtMs === 0) turn.speechStartedAtMs = Date.now();
      return;
    }
    if (msg["type"] === "speech_ended") {
      turn.speechEndedCount += 1;
      turn.speechEndedAtMs = Date.now();
      return;
    }
    if (msg["type"] === "stt_output") {
      if (turn.sttFinalAtMs > 0) return;
      turn.transcript = String(msg["transcript"] ?? "");
      turn.sttFinalAtMs = Date.now();
      return;
    }
    if (msg["type"] === "agent_tool_call") {
      turn.toolCalls.push(String(msg["name"] ?? ""));
      return;
    }
    if (msg["type"] === "agent_chunk") {
      if (turn.firstAgentAtMs === 0) turn.firstAgentAtMs = Date.now();
      turn.agentReply += String(msg["text"] ?? "");
      return;
    }
    if (msg["type"] === "agent_end" && msg["turnId"] === turn.id) {
      if (turn.agentEndedAtMs > 0) return;
      turn.agentEndedAtMs = Date.now();
      return;
    }
    if (msg["type"] === "tts_chunk") {
      nextBinaryBelongsToTurn = true;
      return;
    }
    if (msg["type"] === "tts_end" && msg["turnId"] === turn.id) {
      turn.ttsEndedAtMs = Date.now();
      return;
    }
    if (msg["type"] === "error") {
      turn.error = `websocket error: ${String(msg["component"])} ${String(msg["message"])}`;
    }
  };
  socket.on("message", onMessage);
  return () => socket.off("message", onMessage);
}

async function sendPcmFrames(socket: WebSocket, samples: Int16Array, contextId: string): Promise<void> {
  const pace = process.env["SYRINX_WS_PACE_AUDIO"] !== "0";
  for (let offset = 0; offset < samples.length; offset += FRAME_SAMPLES) {
    const end = Math.min(offset + FRAME_SAMPLES, samples.length);
    const frame = new Int16Array(FRAME_SAMPLES);
    frame.set(samples.subarray(offset, end));
    sendAudioFrame(socket, frame, contextId);
    if (pace) await sleep(20);
  }
}

async function sendSilence(socket: WebSocket, contextId: string, durationMs: number): Promise<void> {
  const frames = Math.ceil(durationMs / 20);
  const pace = process.env["SYRINX_WS_PACE_AUDIO"] !== "0";
  for (let i = 0; i < frames; i += 1) {
    sendAudioFrame(socket, new Int16Array(FRAME_SAMPLES), contextId);
    if (pace) await sleep(20);
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
  while (Date.now() - started < 240_000) {
    if (turn.error) throw new Error(turn.error);
    if (
      turn.sttFinalAtMs > 0 &&
      turn.speechStartedAtMs > 0 &&
      turn.speechEndedAtMs > 0 &&
      turn.firstAgentAtMs > 0 &&
      turn.agentEndedAtMs > 0 &&
      turn.firstAudioAtMs > 0 &&
      turn.ttsEndedAtMs > 0
    ) {
      return;
    }
    await sleep(100);
  }
  throw new Error(
      `turn timeout: ${turn.id}; ` +
      `stt=${String(turn.sttFinalAtMs > 0)} ` +
      `vadStarted=${String(turn.speechStartedAtMs > 0)} ` +
      `vadEnded=${String(turn.speechEndedAtMs > 0)} ` +
      `agentFirst=${String(turn.firstAgentAtMs > 0)} ` +
      `agentEnd=${String(turn.agentEndedAtMs > 0)} ` +
      `audioFirst=${String(turn.firstAudioAtMs > 0)} ` +
      `ttsEnd=${String(turn.ttsEndedAtMs > 0)} ` +
      `toolCalls=${String(turn.toolCalls.length)} ` +
      `transcript=${JSON.stringify(turn.transcript)} ` +
      `reply=${JSON.stringify(turn.agentReply)}`,
  );
}

async function waitForJson(
  socket: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("websocket JSON wait timeout"));
    }, timeoutMs);
    const onMessage = (data: RawData, isBinary: boolean): void => {
      if (isBinary) return;
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}

async function writeTurnAudio(path: string, chunks: readonly Uint8Array[]): Promise<void> {
  const bytes = mergeBytes(chunks);
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const wav = new WaveFile();
  wav.fromScratch(1, 24000, "16", samples);
  await writeFile(path, Buffer.from(wav.toBuffer()));
}

export function evaluateConversation(turns: readonly TurnCapture[], modeledConversationMs: number): ConversationEvaluation {
  const failures: string[] = [];
  const diagnostics: string[] = [];
  if (modeledConversationMs < MIN_MODELED_CONVERSATION_MS) {
    diagnostics.push(`modeled conversation was ${String(modeledConversationMs)}ms, expected at least 480000ms`);
  }
  const totalToolCalls = turns.reduce((sum, turn) => sum + turn.toolCalls.length, 0);
  if (totalToolCalls < Math.ceil(turns.length * 0.5)) {
    diagnostics.push(`expected tools on at least half of turns, got ${String(totalToolCalls)} calls across ${String(turns.length)} turns`);
  }
  for (const requiredIndex of [0, 1, 10]) {
    const turn = turns[requiredIndex];
    if (turn && turn.toolCalls.length === 0) {
      diagnostics.push(`expected tool call missing on ${turn.id}`);
    }
  }
  if (!turns[0]?.transcript.toLowerCase().includes("biology")) diagnostics.push("first STT transcript missed fixture term Biology");
  if (turns.some((turn) => turn.sttFinalAtMs < turn.audioEndedAtMs)) {
    failures.push("one or more turns finalized STT before input audio ended");
  }
  if (turns.some((turn) => turn.firstAudioAtMs < turn.firstAgentAtMs)) {
    failures.push("one or more turns received TTS audio before agent text");
  }
  if (turns.some((turn) => turn.speechStartedAtMs === 0)) failures.push("one or more turns did not emit VAD speech_started");
  if (turns.some((turn) => turn.speechEndedAtMs === 0)) failures.push("one or more turns did not emit VAD speech_ended");
  if (turns.some((turn) => turn.speechEndedAtMs < turn.speechStartedAtMs)) {
    failures.push("one or more turns recorded latest VAD speech_ended before first speech_started");
  }
  const avgVadEnd = average(turns.map((turn) => turn.speechEndedAtMs - turn.audioEndedAtMs));
  if (avgVadEnd > 3500) failures.push(`avg VAD speech end after audio end was ${String(avgVadEnd)}ms, expected <= 3500ms`);
  const firstReply = turns[0]?.agentReply.toLowerCase() ?? "";
  if (!firstReply.includes("add") || (!firstReply.includes("biology") && !firstReply.includes("petition"))) {
    diagnostics.push("first reply missed late add guidance");
  }
  if (!turns.some((turn) => turn.agentReply.toLowerCase().includes("sr-2027-004812"))) {
    diagnostics.push("agent never referenced the Student Relations case number");
  }
  if (turns.some((turn) => assistantAudioMs(turn) < 500)) failures.push("one or more turns returned no useful TTS audio");
  for (const turn of turns) {
    const reply = turn.agentReply.trim();
    if (reply.length < 40) diagnostics.push(`${turn.id} agent reply was short`);
    if (!/[.!?]\s*$/.test(reply)) diagnostics.push(`${turn.id} agent reply did not end cleanly`);
  }
  return { failures, diagnostics };
}

function assistantAudioMs(turn: TurnCapture): number {
  return Math.round((mergeBytes(turn.audioChunks).byteLength / 2 / 24000) * 1000);
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
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

function rawBytes(data: RawData): Uint8Array {
  let bytes: Uint8Array;
  if (Buffer.isBuffer(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else if (Array.isArray(data)) bytes = Uint8Array.from(Buffer.concat(data));
  else throw new Error("Unsupported binary websocket payload");
  if (hasSyrinxAudioEnvelope(bytes)) return decodeSyrinxAudioEnvelope(bytes).audio;
  return bytes;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
