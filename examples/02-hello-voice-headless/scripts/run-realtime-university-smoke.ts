// SPDX-License-Identifier: MIT
//
// Live acceptance gate for WBS-4: bi-model delegate — gpt-realtime-2 front calls
// ask_university, university Reasoner answers, front voices the grounded body.

import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createOpenAI } from "@ai-sdk/openai";
import { tool, stepCountIs } from "ai";
import { z } from "zod";

import {
  Route,
  VoiceAgentSession,
  type LlmToolCallPacket,
  type LlmToolResultPacket,
  type SttResultPacket,
  type TextToSpeechAudioPacket,
  type TextToSpeechEndPacket,
} from "@kuralle-syrinx/core";
import { fromStreamText } from "@kuralle-syrinx/aisdk";
import { RealtimeBridge, fromOpenAIRealtime } from "@kuralle-syrinx/realtime";
import type { RealtimeAdapter, RealtimeEvent, RealtimeToolDef } from "@kuralle-syrinx/realtime";
import { createNodeWsSocket } from "@kuralle-syrinx/ws/node";

import { DEFAULT_MODEL, ensureRepoRootDotenv, readPcm16Mono16kWav } from "../src/run-one-turn.js";

const require = createRequire(import.meta.url);
const { WaveFile } = require("wavefile") as typeof import("wavefile");

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const FIXTURE_PATH = join(PKG_ROOT, "test", "fixtures", "university-support-add-drop.wav");
const OUTPUT_DIR = join(PKG_ROOT, "test", "performance", "runs", "realtime-university-smoke");
const INPUT_SAMPLE_RATE_HZ = 16_000;
const FRAME_SAMPLES = 320;

// The front-model delegate tool lives in the EXAMPLE (domain-specific), not the generic adapter.
const ASK_UNIVERSITY_TOOL: RealtimeToolDef = {
  name: "ask_university",
  description: "Answer university student-relations questions (enrollment, add/drop, advising).",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

const UNIVERSITY_SUPPORT_PROMPT = [
  "You are Syrinx University's Student Relations voice agent.",
  "For enrollment, add-drop, advising, account, or case-status questions, call resolveLateAddRequest before answering.",
  "Never invent deadlines, forms, URLs, account holds, or approvals. If a tool result is incomplete, say what must be checked next.",
  "For spoken replies, use two concise sentences maximum and lead with the student action.",
  "If transcription sounds uncertain, ask one short clarification instead of guessing.",
].join("\n");

const supportTools = {
  resolveLateAddRequest: tool({
    description: "Resolve a student's late add request, including student status, policy, form, approvals, and case creation.",
    inputSchema: z.object({
      studentId: z.string().optional().describe("Student ID if the caller provided one."),
      name: z.string().optional().describe("Student name if the caller provided one."),
      courseCode: z.string().optional().describe("Course code or spoken course name."),
      term: z.string().optional().describe("Academic term if known."),
    }),
    execute: async ({ studentId, name, courseCode, term }) => ({
      student: {
        studentId: studentId ?? "S10042",
        name: name ?? "Maya Chen",
        academicStanding: "good",
        activeHolds: [],
        advisor: "Dr. Priya Raman",
      },
      policy: {
        courseCode: courseCode ?? "Biology 101",
        term: term ?? "Spring 2027",
        addDeadline: "2027-02-05",
        today: "2027-02-09",
        status: "late_add_required",
        requiredForm: "Late Add Petition",
        approvals: ["course instructor", "academic advisor", "registrar"],
        submissionChannel: "Student Relations portal",
      },
      case: {
        caseId: "SR-2027-004812",
        nextStep:
          "Submit the Late Add Petition in the Student Relations portal and route it to the instructor, advisor, and registrar.",
      },
    }),
  }),
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

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  const apiKey = process.env["OPENAI_API_KEY"]?.trim();
  if (!apiKey) throw new Error("missing OPENAI_API_KEY in repo-root .env");

  await mkdir(OUTPUT_DIR, { recursive: true });

  const timeline: TimelineEntry[] = [];
  const startedAt = Date.now();
  const pushTimeline = (event: string, detail?: string): void => {
    timeline.push({ atMs: Date.now() - startedAt, event, detail });
  };

  let assistantTranscript = "";
  const baseAdapter = fromOpenAIRealtime({
    apiKey,
    socketFactory: createNodeWsSocket,
    turnDetection: { type: "server_vad", silence_duration_ms: 500 },
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
  });

  const universityReasoner = fromStreamText({
    model: createOpenAI({ apiKey })(process.env["SYRINX_LLM_MODEL"]?.trim() || DEFAULT_MODEL),
    system: UNIVERSITY_SUPPORT_PROMPT,
    tools: supportTools,
    temperature: 0.2,
    maxOutputTokens: 180,
    maxRetries: 0,
    timeout: 45_000,
    stopWhen: stepCountIs(4),
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
    outputChunks.push(pkt.audio);
  });

  const completion = new Promise<void>((resolve, reject) => {
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const hardTimeout = setTimeout(() => {
      reject(new Error("realtime university smoke timeout"));
    }, 180_000);

    const maybeSettle = (): void => {
      if (!sawToolResult) return;
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        clearTimeout(hardTimeout);
        resolve();
      }, 5000);
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

  await completion;

  if (!sawToolCall) throw new Error("ask_university tool_call was not observed");
  if (!sawToolResult) throw new Error("delegate llm.tool_result was not observed");
  if (!isNonSilentAudio(outputChunks)) throw new Error("captured assistant audio is silent");

  const outPath = join(OUTPUT_DIR, "audio-out.wav");
  await writePcm16Wav(outPath, outputChunks, INPUT_SAMPLE_RATE_HZ);

  const summary = {
    ok: true,
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
