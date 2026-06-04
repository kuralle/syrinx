// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { tool } from "ai";
import { z } from "zod";

import { AISDKBridgePlugin } from "@asyncdot/voice-bridge-aisdk";
import { DeepgramSTTPlugin } from "@asyncdot/voice-stt-deepgram";
import { CartesiaTTSPlugin } from "@asyncdot/voice-tts-cartesia";
import { SileroVADPlugin } from "@asyncdot/voice-vad-silero";

import {
  DEFAULT_MODEL,
  DEFAULT_VOICE_ID,
  coerceGoogleGenAiKey,
  ensureRepoRootDotenv,
  listMissingVoiceHeadlessEnvKeys,
  runOneTurn,
} from "../src/run-one-turn.js";

const require = createRequire(import.meta.url);
const WebSocket = require("ws") as typeof import("ws").default;
const { WaveFile } = require("wavefile") as typeof import("wavefile");

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const FIXTURE_PATH = join(PKG_ROOT, "test", "fixtures", "university-support-add-drop.wav");
const BASELINE_PATH = join(PKG_ROOT, "test", "performance", "university-support-baseline.json");
const RUNS_DIR = join(PKG_ROOT, "test", "performance", "runs");

const INPUT_TEXT =
  "Hi, I'm Maya Chen, student ID S one zero zero four two. I need to know whether I can still add Biology one oh one after the deadline, and what form I should submit.";

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

interface AudioStats {
  readonly durationMs: number;
  readonly bytes: number;
  readonly peak: number;
  readonly rms: number;
}

interface BaselineQualityEvaluation {
  readonly failures: string[];
  readonly diagnostics: string[];
}

async function synthesizeInputFixture(): Promise<void> {
  if (existsSync(FIXTURE_PATH)) return;

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

function readAudioStats(path: string): AudioStats {
  const wav = new WaveFile(Buffer.from(require("node:fs").readFileSync(path)));
  const samplesRaw = wav.getSamples(false, Int16Array);
  const samples = Array.isArray(samplesRaw) ? samplesRaw[0] : samplesRaw;
  if (!(samples instanceof Int16Array)) throw new Error(`expected PCM16 WAV samples in ${path}`);

  let peak = 0;
  let sumSquares = 0;
  for (const sample of samples) {
    const normalized = sample / 32768;
    peak = Math.max(peak, Math.abs(normalized));
    sumSquares += normalized * normalized;
  }
  const sampleRate = (wav.fmt as { sampleRate: number }).sampleRate;
  return {
    durationMs: Math.round((samples.length / sampleRate) * 1000),
    bytes: Buffer.from(wav.toBuffer()).byteLength,
    peak: Number(peak.toFixed(4)),
    rms: Number(Math.sqrt(sumSquares / Math.max(1, samples.length)).toFixed(4)),
  };
}

function includesAny(text: string, terms: readonly string[]): boolean {
  const normalized = text.toLowerCase();
  return terms.some((term) => normalized.includes(term));
}

function artifactPath(path: string): string {
  return relative(PKG_ROOT, path);
}

export function evaluateQuality(
  finalTranscript: string,
  agentReply: string,
  toolCalls: number,
  audio: AudioStats,
): BaselineQualityEvaluation {
  const failures: string[] = [];
  const diagnostics: string[] = [];
  if (!includesAny(finalTranscript, ["maya", "chen"])) diagnostics.push("STT missed fixture term: student name");
  if (!includesAny(finalTranscript, ["biology", "bio"])) diagnostics.push("STT missed fixture term: course");
  if (!includesAny(finalTranscript, ["deadline", "dead line"])) diagnostics.push("STT missed fixture term: deadline intent");
  if (!includesAny(finalTranscript, ["form", "petition"])) diagnostics.push("STT missed fixture term: form intent");
  if (toolCalls < 1) diagnostics.push(`expected at least 1 tool call, got ${toolCalls}`);
  if (!includesAny(agentReply, ["late add", "petition"])) diagnostics.push("agent reply did not mention the Late Add Petition");
  if (!includesAny(agentReply, ["advisor", "registrar", "instructor"])) {
    diagnostics.push("agent reply did not mention required approvals");
  }
  if (audio.durationMs < 500 || audio.rms < 0.001 || audio.peak < 0.01) {
    failures.push("assistant audio output is missing or effectively silent");
  }
  return { failures, diagnostics };
}

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  coerceGoogleGenAiKey();
  const missing = listMissingVoiceHeadlessEnvKeys();
  if (missing.length > 0) throw new Error(`missing live provider env: ${missing.join(", ")}`);

  await synthesizeInputFixture();

  const runId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const sessionDir = join(RUNS_DIR, `university-support-${runId}`);
  const result = await runOneTurn({
    inputWavPath: FIXTURE_PATH,
    sessionDir,
    model: process.env["SYRINX_LLM_MODEL"]?.trim() || DEFAULT_MODEL,
    realtimePacing: true,
    sessionOverrides: {
      plugins: {
        stt: new DeepgramSTTPlugin(),
        vad: new SileroVADPlugin(),
        bridge: new AISDKBridgePlugin(),
        tts: new CartesiaTTSPlugin(),
      },
      pluginConfig: {
        stt: {
          api_key: process.env["DEEPGRAM_API_KEY"],
          sample_rate: 16000,
          endpointing: 700,
          model: "nova-3",
          language: "en-US",
          smart_format: true,
        },
        vad: { threshold: 0.01 },
        bridge: {
          api_key: process.env["OPENAI_API_KEY"],
          model: process.env["SYRINX_LLM_MODEL"]?.trim() || DEFAULT_MODEL,
          system_prompt: UNIVERSITY_SUPPORT_PROMPT,
          tools: supportTools,
          temperature: 0.2,
          max_output_tokens: 180,
          max_steps: 4,
          timeout_ms: 45_000,
        },
        tts: {
          api_key: process.env["CARTESIA_API_KEY"],
          voice_id: process.env["CARTESIA_VOICE_ID"]?.trim() || DEFAULT_VOICE_ID,
          model_id: "sonic-3",
          sample_rate: 16000,
          language: "en",
        },
      },
      sttForceFinalizeTimeoutMs: 4500,
    },
  });

  const inputAudio = readAudioStats(result.inputWavPath);
  const assistantAudio = readAudioStats(result.agentOutWavPath);
  const evaluation = evaluateQuality(result.finalTranscript, result.agentReply, result.metrics.toolCalls, assistantAudio);
  const { failures, diagnostics } = evaluation;
  const baseline = {
    scenario: "university_student_relations_late_add",
    generatedAt: new Date().toISOString(),
    model: process.env["SYRINX_LLM_MODEL"]?.trim() || DEFAULT_MODEL,
    inputText: INPUT_TEXT,
    expectedBehavior: [
      "Use the student-relations tool before answering.",
      "Tell the student to submit the Late Add Petition.",
      "Mention approvals instead of inventing a direct enrollment action.",
      "Produce non-silent assistant speech audio.",
    ],
    transcript: {
      sttFinal: result.finalTranscript,
      agentReply: result.agentReply,
    },
    latencyMs: {
      inputAudio: result.metrics.inputAudioMs,
      sttFinalAfterSpeechEnd: result.metrics.speechEndToFinalTranscriptMs,
      llmTimeToFirstToken: result.metrics.llmTTFTMs,
      ttsTimeToFirstAudio: result.metrics.ttsTTFBMs,
      speechEndToFirstAssistantAudio: result.metrics.speechEndToFirstAudioMs,
      feedStartToFirstAssistantAudio: result.metrics.e2eLatencyMs,
      feedStartToTtsEnd: result.durationMs,
      assistantPlayedAudio: result.metrics.playedMs,
    },
    toolCalls: result.metrics.toolCalls,
    audio: {
      input: { path: artifactPath(result.inputWavPath), ...inputAudio },
      assistant: { path: artifactPath(result.agentOutWavPath), ...assistantAudio },
    },
    diagnostics,
    artifacts: {
      sessionDir: artifactPath(result.sessionDir),
      eventsJsonlPath: artifactPath(result.eventsJsonlPath),
      transcriptJsonPath: artifactPath(result.transcriptJsonPath),
      metricsJsonPath: artifactPath(result.metricsJsonPath),
    },
    qualityGate: {
      passed: failures.length === 0,
      failures,
    },
  };

  await mkdir(dirname(BASELINE_PATH), { recursive: true });
  await writeFile(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");

  console.log(JSON.stringify(baseline, null, 2));
  if (failures.length > 0) {
    throw new Error(`university support baseline failed: ${failures.join("; ")}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
