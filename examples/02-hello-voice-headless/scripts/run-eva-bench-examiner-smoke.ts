// SPDX-License-Identifier: MIT
//
// VE-05 live smoke: bot-to-bot examiner over recorder-backed university session.
// Scores EVA-X turn-taking timing + overlap; runs clean + noise perturbation arms.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Route, type TextToSpeechAudioPacket, type TextToSpeechEndPacket } from "@kuralle-syrinx/core";
import {
  assertVoiceSessionRecorderManifest,
  createVoiceSessionRecorder,
  type VoiceSessionRecorderManifest,
} from "@kuralle-syrinx/recorder";

import {
  compareEvaToBaseline,
  evaluateEvaExaminer,
  measureStereoOverlapMs,
  turnCapturesToTimeline,
  type EvaExaminerScores,
  type EvaGateMode,
  type EvaPerturbationKind,
} from "./eva-evaluator.js";
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
import { createUniversitySupportSession, type UniversitySupportTtsProvider } from "../src/university-support-agent.js";

const require = createRequire(import.meta.url);
const { WaveFile } = require("wavefile") as typeof import("wavefile");

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = join(SCRIPT_DIR, "..", "test", "performance", "runs");
const BASELINE_PATH = join(SCRIPT_DIR, "..", "test", "performance", "eva-bench-examiner-baseline.json");
const INPUT_SAMPLE_RATE_HZ = 16000;
const FRAME_SAMPLES = 320;
const TURN_COUNT = 3;
const POST_TTS_DRAIN_MS = 500;
const POST_USER_SILENCE_MS = 5000;
const NOISE_SNR_DB = 12;

interface TurnCapture {
  readonly id: string;
  readonly fixtureId: string;
  readonly perturbation: EvaPerturbationKind;
  readonly inputText: string;
  readonly inputAudioMs: number;
  userRecorderOffsetBytes: number;
  userRecorderByteLength: number;
  startedAtMs: number;
  speechStartedAtMs: number;
  speechEndedAtMs: number;
  sttFinalAtMs: number;
  firstAgentAtMs: number;
  firstAudioAtMs: number;
  ttsEndedAtMs: number;
  sttTranscript: string;
  agentReply: string;
  assistantAudioBytes: number;
  assistantPlayoutEndMs: number;
  audioEndedAtMs: number;
  error: string;
}

export interface EvaBenchExaminerResult {
  readonly scenario: string;
  readonly generatedAt: string;
  readonly gateMode: EvaGateMode;
  readonly clean: EvaExaminerScores;
  readonly noise: EvaExaminerScores;
  readonly conversationOverlapMs: number;
  readonly qualityGate: {
    readonly passed: boolean;
    readonly failures: readonly string[];
    readonly warnings: readonly string[];
  };
  readonly diagnostics: readonly string[];
}

export function evaluateEvaBenchExaminerGate(
  result: Pick<EvaBenchExaminerResult, "clean" | "noise" | "conversationOverlapMs">,
  baseline: { clean: EvaExaminerScores; noise: EvaExaminerScores } | null,
  mode: EvaGateMode,
): { failures: string[]; warnings: string[]; diagnostics: string[] } {
  const failures: string[] = [];
  const warnings: string[] = [];
  const diagnostics: string[] = [];

  if (result.clean.turnTakingTimingScore < 50) {
    const msg = `clean turn-taking-timing score ${result.clean.turnTakingTimingScore} below floor 50`;
    if (mode === "block") failures.push(msg);
    else warnings.push(msg);
  }
  if (result.noise.turnTakingTimingScore < 40) {
    warnings.push(`noise perturbation turn-taking score ${result.noise.turnTakingTimingScore} below 40`);
  }

  if (baseline) {
    const cleanCompare = compareEvaToBaseline(result.clean, baseline.clean, mode);
    const noiseCompare = compareEvaToBaseline(result.noise, baseline.noise, mode);
    failures.push(...cleanCompare.failures, ...noiseCompare.failures);
    warnings.push(...cleanCompare.warnings, ...noiseCompare.warnings);
  }

  return { failures, warnings, diagnostics };
}

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  coerceGoogleGenAiKey();
  ensureLiveEnv();
  await ensureGeminiUniversityFixtures();

  const gateMode = resolveGateMode();
  const generatedAt = new Date().toISOString();
  const runId = generatedAt.replaceAll(":", "-").replaceAll(".", "-");
  const runDir = join(RUNS_DIR, `eva-bench-examiner-${runId}`);
  const recorderDir = join(runDir, "recorder");
  const whisperDir = join(runDir, "whisper");
  await mkdir(whisperDir, { recursive: true });

  const ttsProvider = chooseTtsProvider();
  const configuredAssistantSampleRateHz = ttsProvider === "cartesia" ? 16000 : 24000;

  const cleanTurns = await runExaminerSession({
    recorderDir,
    sessionId: "eva-clean",
    perturbation: "clean",
    ttsProvider,
    assistantSampleRateHz: configuredAssistantSampleRateHz,
  });

  const noiseTurns = await runExaminerSession({
    recorderDir: join(runDir, "recorder-noise"),
    sessionId: "eva-noise",
    perturbation: "noise",
    ttsProvider,
    assistantSampleRateHz: configuredAssistantSampleRateHz,
  });

  const conversationWav = join(recorderDir, "eva-clean", "conversation.wav");
  const conversationOverlapMs = measureStereoOverlapMs(conversationWav);
  const totalConversationMs = cleanTurns.reduce((sum, t) => sum + t.inputAudioMs, 0) +
    cleanTurns.reduce((sum, t) => sum + Math.round((t.assistantAudioBytes / 2 / configuredAssistantSampleRateHz) * 1000), 0);

  const cleanTimeline = turnCapturesToTimeline(cleanTurns);
  const noiseTimeline = turnCapturesToTimeline(noiseTurns);
  const cleanEval = evaluateEvaExaminer({
    turns: cleanTimeline,
    conversationOverlapMs,
    totalConversationMs,
    perturbation: "clean",
  });
  const noiseEval = evaluateEvaExaminer({
    turns: noiseTimeline,
    conversationOverlapMs: 0,
    totalConversationMs: noiseTurns.reduce((sum, t) => sum + t.inputAudioMs, 0),
    perturbation: "noise",
  });

  let baseline: EvaBenchExaminerResult | null = null;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as EvaBenchExaminerResult;
  } catch {
    baseline = null;
  }

  const gate = evaluateEvaBenchExaminerGate(
    { clean: cleanEval.scores, noise: noiseEval.scores, conversationOverlapMs },
    baseline ? { clean: baseline.clean, noise: baseline.noise } : null,
    gateMode,
  );
  const failures = [...cleanEval.failures, ...gate.failures];
  const warnings = [...cleanEval.warnings, ...noiseEval.warnings, ...gate.warnings];
  const diagnostics = [...cleanEval.diagnostics, ...noiseEval.diagnostics, ...gate.diagnostics];

  const recorderUserWav = join(runDir, "recorder-user.wav");
  const recorderAssistantWav = join(runDir, "recorder-assistant.wav");
  await writePcmFileAsWav(
    join(recorderDir, "eva-clean", "user_audio.pcm"),
    recorderUserWav,
    INPUT_SAMPLE_RATE_HZ,
  );
  const cleanManifest = readValidatedRecorderManifest(join(recorderDir, "eva-clean", "manifest.json"));
  const assistantRate = readRecorderAssistantSampleRateHz(cleanManifest);
  await writePcmFileAsWav(
    join(recorderDir, "eva-clean", "assistant_audio.pcm"),
    recorderAssistantWav,
    assistantRate,
  );

  const [whisperUser, whisperAssistant] = await Promise.all([
    transcribeWithLocalWhisper(recorderUserWav, whisperDir, "recorder-user"),
    transcribeWithLocalWhisper(recorderAssistantWav, whisperDir, "recorder-assistant"),
  ]);
  diagnostics.push(`whisper user chars=${whisperUser.text.length}`);
  diagnostics.push(`whisper assistant chars=${whisperAssistant.text.length}`);

  const result: EvaBenchExaminerResult = {
    scenario: "eva_bench_examiner_university_three_turn",
    generatedAt,
    gateMode,
    clean: cleanEval.scores,
    noise: noiseEval.scores,
    conversationOverlapMs,
    qualityGate: {
      passed: failures.length === 0,
      failures,
      warnings,
    },
    diagnostics,
  };

  await writeFile(join(runDir, "baseline.json"), `${JSON.stringify({
    ...result,
    turnCount: TURN_COUNT,
    sttProvider: "deepgram",
    llmModel: process.env["SYRINX_LLM_MODEL"]?.trim() || DEFAULT_MODEL,
    ttsProvider,
    localWhisperModel: process.env["SYRINX_LOCAL_WHISPER_MODEL"]?.trim() || "tiny.en",
    turns: cleanTurns.map((turn) => ({
      id: turn.id,
      fixtureId: turn.fixtureId,
      perturbation: turn.perturbation,
      sttTranscript: turn.sttTranscript,
      agentReply: turn.agentReply,
      latencyMs: {
        responseLatency: turn.firstAudioAtMs - turn.speechEndedAtMs,
        sttFinalAfterAudioEnd: turn.sttFinalAtMs - (turn.startedAtMs + turn.inputAudioMs),
      },
    })),
    artifacts: {
      runDir: relative(PKG_ROOT, runDir),
      conversationWav: relative(PKG_ROOT, conversationWav),
      whisperUserJsonPath: relative(PKG_ROOT, whisperUser.jsonPath),
      whisperAssistantJsonPath: relative(PKG_ROOT, whisperAssistant.jsonPath),
    },
  }, null, 2)}\n`, "utf8");

  await writeFile(BASELINE_PATH, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(result, null, 2));
  if (failures.length > 0) {
    throw new Error(`eva-bench examiner smoke failed: ${failures.join("; ")}`);
  }
}

async function runExaminerSession(options: {
  recorderDir: string;
  sessionId: string;
  perturbation: EvaPerturbationKind;
  ttsProvider: UniversitySupportTtsProvider;
  assistantSampleRateHz: number;
}): Promise<TurnCapture[]> {
  await mkdir(options.recorderDir, { recursive: true });
  const session = createUniversitySupportSession({
    inputSampleRate: INPUT_SAMPLE_RATE_HZ,
    profile: "interactive",
    ttsProvider: options.ttsProvider,
  });
  session.registerPlugin("recorder", createVoiceSessionRecorder({
    outputDir: options.recorderDir,
    sessionId: options.sessionId,
    userSampleRateHz: INPUT_SAMPLE_RATE_HZ,
    assistantSampleRateHz: options.assistantSampleRateHz,
  }));

  await session.start();
  const turns: TurnCapture[] = [];
  let userRecorderOffsetBytes = 0;
  try {
    for (let index = 0; index < TURN_COUNT; index += 1) {
      const fixture = GEMINI_UNIVERSITY_FIXTURES[index]!;
      let samples = readPcm16Mono16kWav(fixture.path);
      if (options.perturbation === "noise") {
        const { applyAccentPerturbation, applyNoisePerturbation } = await import("./eva-evaluator.js");
        if (index === 0) samples = applyNoisePerturbation(samples, NOISE_SNR_DB);
        if (index === 1) samples = applyAccentPerturbation(samples, 1.06);
      }
      const turn: TurnCapture = {
        id: `${options.perturbation}-turn-${String(index + 1).padStart(2, "0")}`,
        fixtureId: fixture.id,
        perturbation: options.perturbation,
        inputText: fixture.text,
        inputAudioMs: Math.round((samples.length / INPUT_SAMPLE_RATE_HZ) * 1000),
        userRecorderOffsetBytes,
        userRecorderByteLength: 0,
        startedAtMs: Date.now(),
        speechStartedAtMs: 0,
        speechEndedAtMs: 0,
        sttFinalAtMs: 0,
        firstAgentAtMs: 0,
        firstAudioAtMs: 0,
        ttsEndedAtMs: 0,
        sttTranscript: "",
        agentReply: "",
        assistantAudioBytes: 0,
        assistantPlayoutEndMs: 0,
        audioEndedAtMs: 0,
        error: "",
      };
      const dispose = captureTurn(session, turn);
      session.bus.push(Route.Main, {
        kind: "turn.change",
        contextId: turn.id,
        previousContextId: turns.at(-1)?.id ?? "",
        reason: "eva_bench_examiner",
        timestampMs: Date.now(),
      });
      turn.userRecorderByteLength += await sendPcmFrames(session, samples, turn.id);
      turn.audioEndedAtMs = Date.now();
      turn.userRecorderByteLength += await sendSilence(session, turn.id, POST_USER_SILENCE_MS);
      await waitForTurnComplete(turn);
      const remainingPlayoutMs = Math.max(0, turn.assistantPlayoutEndMs - Date.now());
      await sleep(remainingPlayoutMs + POST_TTS_DRAIN_MS);
      dispose();
      turns.push(turn);
      userRecorderOffsetBytes += turn.userRecorderByteLength;
    }
  } finally {
    await session.close();
  }
  return turns;
}

function captureTurn(
  session: ReturnType<typeof createUniversitySupportSession>,
  turn: TurnCapture,
): () => void {
  const offStt = session.bus.on("stt.result", (pkt) => {
    const stt = pkt as unknown as { contextId: string; text: string; timestampMs: number };
    if (stt.contextId !== turn.id || turn.sttFinalAtMs > 0) return;
    turn.sttTranscript = stt.text;
    turn.sttFinalAtMs = stt.timestampMs;
  });
  const offVadStart = session.bus.on("vad.speech_started", (pkt) => {
    const vad = pkt as { contextId: string; timestampMs: number };
    if (vad.contextId === turn.id && turn.speechStartedAtMs === 0) {
      turn.speechStartedAtMs = vad.timestampMs;
    }
  });
  const offVad = session.bus.on("vad.speech_ended", (pkt) => {
    const vad = pkt as { contextId: string; timestampMs: number };
    if (vad.contextId === turn.id) turn.speechEndedAtMs = vad.timestampMs;
  });
  const offTtsAudio = session.bus.on<TextToSpeechAudioPacket>("tts.audio", (pkt) => {
    if (pkt.contextId !== turn.id) return;
    if (turn.firstAudioAtMs === 0) turn.firstAudioAtMs = pkt.timestampMs;
    turn.assistantAudioBytes += pkt.audio.byteLength;
    const chunkMs = (pkt.audio.byteLength / 2 / pkt.sampleRateHz) * 1000;
    const playoutBaseMs = Math.max(Date.now(), turn.assistantPlayoutEndMs);
    turn.assistantPlayoutEndMs = playoutBaseMs + chunkMs;
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
    offVadStart();
    offVad();
    offTtsAudio();
    offTtsEnd();
    session.off("agent_text_delta", onAgentDelta);
    session.off("error", onError);
  };
}

async function sendPcmFrames(
  session: ReturnType<typeof createUniversitySupportSession>,
  samples: Int16Array,
  contextId: string,
): Promise<number> {
  let byteLength = 0;
  for (let offset = 0; offset < samples.length; offset += FRAME_SAMPLES) {
    const frame = new Int16Array(FRAME_SAMPLES);
    frame.set(samples.subarray(offset, Math.min(samples.length, offset + FRAME_SAMPLES)));
    session.bus.push(Route.Main, {
      kind: "user.audio_received",
      contextId,
      timestampMs: Date.now(),
      audio: new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength),
    });
    byteLength += frame.byteLength;
    await sleep(20);
  }
  return byteLength;
}

async function sendSilence(
  session: ReturnType<typeof createUniversitySupportSession>,
  contextId: string,
  durationMs: number,
): Promise<number> {
  const frames = Math.ceil(durationMs / 20);
  let byteLength = 0;
  for (let i = 0; i < frames; i += 1) {
    const frame = new Int16Array(FRAME_SAMPLES);
    session.bus.push(Route.Main, {
      kind: "user.audio_received",
      contextId,
      timestampMs: Date.now(),
      audio: new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength),
    });
    byteLength += frame.byteLength;
    await sleep(20);
  }
  return byteLength;
}

async function waitForTurnComplete(turn: TurnCapture): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 180_000) {
    if (turn.error) throw new Error(turn.error);
    if (
      turn.sttFinalAtMs > 0 &&
      turn.speechEndedAtMs > 0 &&
      turn.firstAgentAtMs > 0 &&
      turn.firstAudioAtMs > 0 &&
      turn.ttsEndedAtMs > 0
    ) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`turn timeout ${turn.id}`);
}

function readValidatedRecorderManifest(path: string): VoiceSessionRecorderManifest {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  assertVoiceSessionRecorderManifest(parsed);
  return parsed;
}

function readRecorderAssistantSampleRateHz(manifest: VoiceSessionRecorderManifest): number {
  return manifest.audio.assistant.sampleRateHz;
}

async function transcribeWithLocalWhisper(
  wavPath: string,
  outputDir: string,
  id: string,
): Promise<{ text: string; jsonPath: string }> {
  const command = process.env["SYRINX_LOCAL_WHISPER_BIN"]?.trim() || "whisper";
  const model = process.env["SYRINX_LOCAL_WHISPER_MODEL"]?.trim() || "tiny.en";
  const modelOutputDir = join(outputDir, id);
  await mkdir(modelOutputDir, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [
      wavPath,
      "--model",
      model,
      "--language",
      "en",
      "--output_format",
      "json",
      "--output_dir",
      modelOutputDir,
      "--fp16",
      "False",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`local Whisper failed for ${id}: ${stderr}`));
    });
  });
  const base = wavPath.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? id;
  const jsonPath = join(modelOutputDir, `${base}.json`);
  const parsed = JSON.parse(readFileSync(jsonPath, "utf8")) as { text?: string };
  return { text: parsed.text?.trim() ?? "", jsonPath };
}

async function writePcmFileAsWav(inputPath: string, outputPath: string, sampleRateHz: number): Promise<void> {
  const pcm = readFileSync(inputPath);
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  const wav = new WaveFile();
  wav.fromScratch(1, sampleRateHz, "16", samples);
  await writeFile(outputPath, Buffer.from(wav.toBuffer()));
}

function resolveGateMode(): EvaGateMode {
  const raw = process.env["SYRINX_EVA_GATE_MODE"]?.trim().toLowerCase();
  return raw === "block" ? "block" : "warn";
}

function ensureLiveEnv(): void {
  const missing: string[] = [];
  if (!process.env["DEEPGRAM_API_KEY"]?.trim()) missing.push("DEEPGRAM_API_KEY");
  if (!process.env["GOOGLE_GENERATIVE_AI_API_KEY"]?.trim()) missing.push("GOOGLE_GENERATIVE_AI_API_KEY");
  if (chooseTtsProvider() === "cartesia" && !process.env["CARTESIA_API_KEY"]?.trim()) {
    missing.push("CARTESIA_API_KEY");
  }
  if (missing.length > 0) throw new Error(`missing live provider env: ${missing.join(", ")}`);
}

function chooseTtsProvider(): UniversitySupportTtsProvider {
  const requested = process.env["SYRINX_REVIEW_TTS"]?.trim().toLowerCase();
  if (requested === "gemini" || requested === "cartesia" || requested === "deepgram") return requested;
  return process.env["CARTESIA_API_KEY"]?.trim() ? "cartesia" : "gemini";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
