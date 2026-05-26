// SPDX-License-Identifier: MIT

import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { tool } from "ai";
import WebSocket, { type RawData } from "ws";
import { z } from "zod";

import { VoiceAgentSession } from "@asyncdot/voice";
import { AISDKBridgePlugin } from "@asyncdot/voice-bridge-aisdk";
import { createVoiceWebSocketServer } from "@asyncdot/voice-server-websocket";
import { DeepgramSTTPlugin } from "@asyncdot/voice-stt-deepgram";
import { GeminiTTSPlugin } from "@asyncdot/voice-tts-gemini";

import {
  GEMINI_UNIVERSITY_FIXTURES,
  PKG_ROOT,
  ensureGeminiUniversityFixtures,
  readPcm16Wav,
} from "./generate-gemini-university-fixtures.js";
import { DEFAULT_MODEL, coerceGoogleGenAiKey, ensureRepoRootDotenv } from "../src/run-one-turn.js";

const require = createRequire(import.meta.url);
const { WaveFile } = require("wavefile") as typeof import("wavefile");

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = join(SCRIPT_DIR, "..", "test", "performance", "runs");
const BASELINE_PATH = join(SCRIPT_DIR, "..", "test", "performance", "websocket-university-multiturn-baseline.json");
const INPUT_SAMPLE_RATE = 24000;
const FRAME_SAMPLES = 480;
const MIN_MODELED_CONVERSATION_MS = 480_000;

const SYSTEM_PROMPT = [
  "You are Syrinx University's Student Relations voice agent.",
  "This is one ongoing phone conversation. Use the previous turns for references like it, that, the case, or the petition.",
  "Call studentRelationsLookup before answering each student-services request.",
  "Never invent deadlines, approvals, holds, fees, visa guidance, accommodations, appointments, or case status.",
  "For voice, answer in two complete sentences. Confirm the action first, then mention the constraint or next owner.",
  "Never end with an incomplete sentence or phrase. Every answer must end with punctuation.",
].join("\n");

const studentRelationsTool = {
  studentRelationsLookup: tool({
    description:
      "Lookup Student Relations data for a student's registration, late-add, holds, aid, housing, visa, accessibility, athletics, fee, case, appointment, or summary request.",
    inputSchema: z.object({
      studentId: z.string().optional(),
      name: z.string().optional(),
      requestType: z.string().describe("Short request type, for example late_add, holds, aid, visa, case, appointment."),
      courseCode: z.string().optional(),
      summary: z.string().optional(),
    }),
    execute: async ({ studentId, name, requestType, courseCode, summary }) => ({
      requestType,
      summary,
      student: {
        studentId: studentId ?? "S10042",
        name: name ?? "Maya Chen",
        academicStanding: "good",
        activeHolds: [],
        advisor: "Dr. Priya Raman",
        backupAdvisor: "Student Relations advising desk",
        internationalOfficeRequired: true,
        athleticsCoordinator: "Jordan Lee",
      },
      registration: {
        courseCode: courseCode ?? "Biology 101",
        term: "Spring 2027",
        addDeadline: "2027-02-05",
        currentDate: "2027-02-09",
        status: "late_add_required",
        form: "Late Add Petition",
        approvals: ["course instructor", "academic advisor or advising desk", "registrar"],
        portal: "Student Relations portal",
        labFee: "$85 biology lab fee, posted after registrar processing",
      },
      relatedOffices: {
        financialAid: "Full-time status review is Friday at 5 PM.",
        internationalOffice: "Notify International Student Services while the petition is pending.",
        housing: "Use pending late-add case number on the renewal form.",
        accessibility: "Accessibility office should review lab-time accommodation before registrar processing.",
        athletics: "Athletics academic coordinator can be added as a case watcher.",
      },
      case: {
        caseId: "SR-2027-004812",
        status: "open",
        nextSteps: [
          "Upload instructor email and department lab-seat confirmation.",
          "Route the Late Add Petition to the instructor, advising desk, and registrar.",
          "Notify International Student Services and Financial Aid today.",
          "Add accessibility and athletics notes as case watchers.",
        ],
        appointment: "Video appointment available tomorrow at 2:45 PM.",
      },
    }),
  }),
};

interface TurnCapture {
  readonly id: string;
  readonly fixtureId: string;
  readonly inputText: string;
  inputAudioMs: number;
  startedAtMs: number;
  audioEndedAtMs: number;
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
    const failures = evaluateConversation(turns, modeledConversationMs);
    const baseline = {
      scenario: "websocket_university_student_relations_multiturn",
      generatedAt: new Date().toISOString(),
      fixtureProvider: "gemini-tts",
      llmModel: process.env["SYRINX_LLM_MODEL"]?.trim() || DEFAULT_MODEL,
      ttsModel: process.env["SYRINX_GEMINI_TTS_MODEL"]?.trim() || "gemini-2.5-flash-preview-tts",
      transport: "websocket",
      turnCount: turns.length,
      modeledConversationMs,
      latencyMs: {
        totalInputAudio: totalInputAudioMs,
        totalAssistantAudio: totalAssistantAudioMs,
        avgSttFinalAfterSpeechEnd: average(turns.map((turn) => turn.sttFinalAtMs - turn.audioEndedAtMs)),
        avgLlmTimeToFirstText: average(turns.map((turn) => turn.firstAgentAtMs - turn.sttFinalAtMs)),
        avgTtsTimeToFirstAudio: average(turns.map((turn) => turn.firstAudioAtMs - turn.agentEndedAtMs)),
        avgSpeechEndToFirstAssistantAudio: average(turns.map((turn) => turn.firstAudioAtMs - turn.audioEndedAtMs)),
      },
      turns: turns.map((turn) => ({
        id: turn.id,
        fixtureId: turn.fixtureId,
        inputText: turn.inputText,
        sttFinal: turn.transcript,
        agentReply: turn.agentReply,
        toolCalls: turn.toolCalls,
        inputAudioMs: turn.inputAudioMs,
        assistantAudioMs: assistantAudioMs(turn),
        latencyMs: {
          sttFinalAfterSpeechEnd: turn.sttFinalAtMs - turn.audioEndedAtMs,
          llmTimeToFirstText: turn.firstAgentAtMs - turn.sttFinalAtMs,
          ttsTimeToFirstAudio: turn.firstAudioAtMs - turn.agentEndedAtMs,
          speechEndToFirstAssistantAudio: turn.firstAudioAtMs - turn.audioEndedAtMs,
          turnWallClock: turn.ttsEndedAtMs - turn.startedAtMs,
        },
        assistantAudioPath: relative(PKG_ROOT, join(outputDir, `${turn.id}.wav`)),
      })),
      artifacts: {
        runDir: relative(PKG_ROOT, runDir),
        assistantAudioDir: relative(PKG_ROOT, outputDir),
      },
      qualityGate: {
        passed: failures.length === 0,
        failures,
      },
    };

    await mkdir(dirname(BASELINE_PATH), { recursive: true });
    await writeFile(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(baseline, null, 2));
    if (failures.length > 0) throw new Error(`websocket university smoke failed: ${failures.join("; ")}`);
  } finally {
    await server.close();
  }
}

function createSession(): VoiceAgentSession {
  const session = new VoiceAgentSession({
    plugins: {
      stt: {
        api_key: process.env["DEEPGRAM_API_KEY"],
        sample_rate: INPUT_SAMPLE_RATE,
        endpointing: 5000,
        model: "nova-2",
        language: "en-US",
        smart_format: true,
        finalize_on_speech_final: false,
      },
      bridge: {
        api_key: process.env["GOOGLE_GENERATIVE_AI_API_KEY"],
        model: process.env["SYRINX_LLM_MODEL"]?.trim() || DEFAULT_MODEL,
        system_prompt: SYSTEM_PROMPT,
        tools: studentRelationsTool,
        temperature: 0.2,
        max_output_tokens: 420,
        max_steps: 3,
        max_history_turns: 20,
        timeout_ms: 60_000,
      },
      tts: {
        api_key: process.env["GOOGLE_GENERATIVE_AI_API_KEY"],
        model: process.env["SYRINX_GEMINI_TTS_MODEL"]?.trim() || "gemini-2.5-flash-preview-tts",
        voice_name: process.env["SYRINX_GEMINI_TTS_VOICE"]?.trim() || "Kore",
        retry_max_attempts: 2,
        timeout_ms: 45_000,
      },
    },
    idleTimeout: {
      durationMs: 30 * 60_000,
      maxConsecutive: 0,
      disconnectAfterMax: false,
    },
    sttForceFinalizeTimeoutMs: 15_000,
  });
  session.registerPlugin("stt", new DeepgramSTTPlugin());
  session.registerPlugin("bridge", new AISDKBridgePlugin());
  session.registerPlugin("tts", new GeminiTTSPlugin());
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
    const pcm = readPcm16Wav(fixture.path);
    if (pcm.sampleRate !== INPUT_SAMPLE_RATE) {
      throw new Error(`expected ${String(INPUT_SAMPLE_RATE)} Hz fixture: ${fixture.path}`);
    }

    const turn: TurnCapture = {
      id: `turn-${String(index + 1).padStart(2, "0")}`,
      fixtureId: fixture.id,
      inputText: fixture.text,
      inputAudioMs: Math.round((pcm.samples.length / pcm.sampleRate) * 1000),
      startedAtMs: Date.now(),
      audioEndedAtMs: 0,
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
    await sendPcmFrames(socket, pcm.samples, turn.id);
    turn.audioEndedAtMs = Date.now();
    await sendSilence(socket, turn.id, 5000);
    await waitForTurnComplete(turn);
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
  const onMessage = (data: RawData, isBinary: boolean): void => {
    if (isBinary) {
      if (turn.agentEndedAtMs === 0) return;
      if (turn.firstAudioAtMs === 0) turn.firstAudioAtMs = Date.now();
      turn.audioChunks.push(rawBytes(data));
      return;
    }

    const msg = JSON.parse(data.toString()) as Record<string, unknown>;
    if (typeof msg["turnId"] === "string" && msg["turnId"] !== turn.id) return;
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
    audio: Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength).toString("base64"),
  }));
}

async function waitForTurnComplete(turn: TurnCapture): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 240_000) {
    if (turn.error) throw new Error(turn.error);
    if (
      turn.sttFinalAtMs > 0 &&
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

function evaluateConversation(turns: readonly TurnCapture[], modeledConversationMs: number): string[] {
  const failures: string[] = [];
  if (modeledConversationMs < MIN_MODELED_CONVERSATION_MS) {
    failures.push(`modeled conversation was ${String(modeledConversationMs)}ms, expected at least 480000ms`);
  }
  const totalToolCalls = turns.reduce((sum, turn) => sum + turn.toolCalls.length, 0);
  if (totalToolCalls < Math.ceil(turns.length * 0.65)) {
    failures.push(`expected tools on most turns, got ${String(totalToolCalls)} calls across ${String(turns.length)} turns`);
  }
  for (const requiredIndex of [0, 1, 10, 22]) {
    const turn = turns[requiredIndex];
    if (turn && turn.toolCalls.length === 0) {
      failures.push(`required tool call missing on ${turn.id}`);
    }
  }
  if (!turns[0]?.transcript.toLowerCase().includes("biology")) failures.push("first STT transcript missed Biology");
  const firstReply = turns[0]?.agentReply.toLowerCase() ?? "";
  if (!firstReply.includes("add") || (!firstReply.includes("biology") && !firstReply.includes("petition"))) {
    failures.push("first reply missed late add guidance");
  }
  if (!turns.some((turn) => turn.agentReply.toLowerCase().includes("sr-2027-004812"))) {
    failures.push("agent never referenced the Student Relations case number");
  }
  if (turns.some((turn) => assistantAudioMs(turn) < 500)) failures.push("one or more turns returned no useful TTS audio");
  return failures;
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
  if (Buffer.isBuffer(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return Uint8Array.from(Buffer.concat(data));
  throw new Error("Unsupported binary websocket payload");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
