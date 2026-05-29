// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Route, type TextToSpeechAudioPacket, type TextToSpeechEndPacket } from "@asyncdot/voice";
import { createVoiceSessionRecorder } from "@asyncdot/voice-recorder";

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
const INPUT_SAMPLE_RATE_HZ = 16000;
const FRAME_SAMPLES = 320;
const TURN_COUNT = 3;
const POST_TTS_DRAIN_MS = 500;
const POST_USER_SILENCE_MS = 5000;

interface TurnCapture {
  readonly id: string;
  readonly fixtureId: string;
  readonly inputText: string;
  readonly inputAudioMs: number;
  userRecorderOffsetBytes: number;
  userRecorderByteLength: number;
  audioEndedAtMs: number;
  speechEndedAtMs: number;
  sttFinalAtMs: number;
  firstAgentAtMs: number;
  firstAudioAtMs: number;
  ttsEndedAtMs: number;
  sttTranscript: string;
  agentReply: string;
  spokenReply: string;
  toolCalls: string[];
  assistantAudioBytes: number;
  assistantAudioChunks: Uint8Array[];
  error: string;
}

interface WhisperResult {
  readonly text: string;
  readonly jsonPath: string;
}

interface TurnRecordingArtifact {
  readonly turnId: string;
  readonly fixtureId: string;
  readonly userAudioWavPath: string;
  readonly assistantAudioWavPath: string;
  readonly userDurationMs: number;
  readonly assistantDurationMs: number;
}

interface RecorderManifest {
  readonly audio: {
    readonly user: { readonly byteLength: number; readonly durationMs: number; readonly chunks: number };
    readonly assistant: {
      readonly sampleRateHz?: number;
      readonly byteLength: number;
      readonly durationMs: number;
      readonly chunks: number;
      readonly truncations: number;
    };
  };
  readonly events: { readonly packets: number };
}

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  coerceGoogleGenAiKey();
  ensureLiveEnv();
  await ensureGeminiUniversityFixtures();

  const generatedAt = new Date().toISOString();
  const runId = generatedAt.replaceAll(":", "-").replaceAll(".", "-");
  const runDir = join(RUNS_DIR, `live-university-recorder-${runId}`);
  const recorderDir = join(runDir, "recorder");
  const whisperDir = join(runDir, "whisper");
  await mkdir(whisperDir, { recursive: true });

  const ttsProvider = chooseTtsProvider();
  const configuredAssistantSampleRateHz = ttsProvider === "cartesia" ? 16000 : 24000;
  const session = createUniversitySupportSession({
    inputSampleRate: INPUT_SAMPLE_RATE_HZ,
    profile: "interactive",
    ttsProvider,
  });
  session.registerPlugin("recorder", createVoiceSessionRecorder({
    outputDir: recorderDir,
    sessionId: "three-turn-live",
    userSampleRateHz: INPUT_SAMPLE_RATE_HZ,
    assistantSampleRateHz: configuredAssistantSampleRateHz,
  }));

  await session.start();
  let turns: TurnCapture[] = [];
  try {
    turns = await runThreeTurns(session);
  } finally {
    await session.close();
  }

  const recorderUserPcm = join(recorderDir, "three-turn-live", "user_audio.pcm");
  const recorderAssistantPcm = join(recorderDir, "three-turn-live", "assistant_audio.pcm");
  const recorderManifestPath = join(recorderDir, "three-turn-live", "manifest.json");
  const recorderEventsPath = join(recorderDir, "three-turn-live", "events.jsonl");
  const recorderUserWav = join(runDir, "recorder-user.wav");
  const recorderAssistantWav = join(runDir, "recorder-assistant.wav");
  const recorderManifest = JSON.parse(readFileSync(recorderManifestPath, "utf8")) as RecorderManifest;
  const recorderAssistantSampleRateHz = readRecorderAssistantSampleRateHz(recorderManifest);
  await writePcmFileAsWav(recorderUserPcm, recorderUserWav, INPUT_SAMPLE_RATE_HZ);
  await writePcmFileAsWav(recorderAssistantPcm, recorderAssistantWav, recorderAssistantSampleRateHz);
  const turnRecordings = await writeTurnRecordings({
    turns,
    runDir,
    recorderUserPcmPath: recorderUserPcm,
    userSampleRateHz: INPUT_SAMPLE_RATE_HZ,
    assistantSampleRateHz: recorderAssistantSampleRateHz,
  });

  const [whisperUser, whisperAssistant] = await Promise.all([
    transcribeWithLocalWhisper(recorderUserWav, whisperDir, "recorder-user"),
    transcribeWithLocalWhisper(recorderAssistantWav, whisperDir, "recorder-assistant"),
  ]);

  const failures = evaluateQuality(turns, recorderManifest, whisperUser.text, whisperAssistant.text);
  const baseline = {
    scenario: "live_university_recorder_three_turn_coherence",
    generatedAt,
    sttProvider: "deepgram",
    llmModel: process.env["SYRINX_LLM_MODEL"]?.trim() || DEFAULT_MODEL,
    ttsProvider,
    localWhisperModel: process.env["SYRINX_LOCAL_WHISPER_MODEL"]?.trim() || "tiny.en",
    turnCount: turns.length,
    transcripts: {
      providerUserTurns: turns.map((turn) => ({
        id: turn.id,
        fixtureId: turn.fixtureId,
        expected: turn.inputText,
        sttFinal: turn.sttTranscript,
      })),
      agentReplies: turns.map((turn) => ({ id: turn.id, text: turn.agentReply })),
      spokenTtsReplies: turns.map((turn) => ({ id: turn.id, text: turn.spokenReply })),
      recorderUserWhisper: whisperUser.text,
      recorderAssistantWhisper: whisperAssistant.text,
    },
    latencyMs: {
      avgSttFinalAfterAudioEnd: average(turns.map((turn) => turn.sttFinalAtMs - turn.audioEndedAtMs)),
      avgVadSpeechEndAfterAudioEnd: average(turns.map((turn) => turn.speechEndedAtMs - turn.audioEndedAtMs)),
      avgLlmFirstTextAfterStt: average(turns.map((turn) => turn.firstAgentAtMs - turn.sttFinalAtMs)),
      avgFirstAudioAfterAgentText: average(turns.map((turn) => turn.firstAudioAtMs - turn.firstAgentAtMs)),
      avgSpeechEndToFirstAssistantAudio: average(turns.map((turn) => turn.firstAudioAtMs - turn.audioEndedAtMs)),
    },
    recorder: {
      manifestPath: relative(PKG_ROOT, recorderManifestPath),
      eventsJsonlPath: relative(PKG_ROOT, recorderEventsPath),
      userAudioWavPath: relative(PKG_ROOT, recorderUserWav),
      assistantAudioWavPath: relative(PKG_ROOT, recorderAssistantWav),
      turnRecordings,
      manifest: recorderManifest,
    },
    artifacts: {
      runDir: relative(PKG_ROOT, runDir),
      whisperUserJsonPath: relative(PKG_ROOT, whisperUser.jsonPath),
      whisperAssistantJsonPath: relative(PKG_ROOT, whisperAssistant.jsonPath),
      baselinePath: relative(PKG_ROOT, join(runDir, "baseline.json")),
    },
    turns: turns.map((turn) => ({
      id: turn.id,
      fixtureId: turn.fixtureId,
      inputAudioMs: turn.inputAudioMs,
      userRecordingMs: Math.round((turn.userRecorderByteLength / 2 / INPUT_SAMPLE_RATE_HZ) * 1000),
      assistantAudioMs: Math.round((turn.assistantAudioBytes / 2 / recorderAssistantSampleRateHz) * 1000),
      toolCalls: turn.toolCalls,
      spokenTtsWords: turn.spokenReply.trim() ? turn.spokenReply.trim().split(/\s+/).length : 0,
      latencyMs: {
        sttFinalAfterAudioEnd: turn.sttFinalAtMs - turn.audioEndedAtMs,
        vadSpeechEndAfterAudioEnd: turn.speechEndedAtMs - turn.audioEndedAtMs,
        llmFirstTextAfterStt: turn.firstAgentAtMs - turn.sttFinalAtMs,
        firstAudioAfterAgentText: turn.firstAudioAtMs - turn.firstAgentAtMs,
        speechEndToFirstAssistantAudio: turn.firstAudioAtMs - turn.audioEndedAtMs,
        turnWallClock: turn.ttsEndedAtMs - (turn.audioEndedAtMs - turn.inputAudioMs),
      },
    })),
    qualityGate: {
      passed: failures.length === 0,
      failures,
    },
  };

  await writeFile(join(runDir, "baseline.json"), `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(baseline, null, 2));
  if (failures.length > 0) throw new Error(`live recorder coherence smoke failed: ${failures.join("; ")}`);
}

async function runThreeTurns(session: ReturnType<typeof createUniversitySupportSession>): Promise<TurnCapture[]> {
  const turns: TurnCapture[] = [];
  let userRecorderOffsetBytes = 0;
  for (let index = 0; index < TURN_COUNT; index += 1) {
    const fixture = GEMINI_UNIVERSITY_FIXTURES[index]!;
    const samples = readPcm16Mono16kWav(fixture.path);
    const turn: TurnCapture = {
      id: `live-turn-${String(index + 1).padStart(2, "0")}`,
      fixtureId: fixture.id,
      inputText: fixture.text,
      inputAudioMs: Math.round((samples.length / INPUT_SAMPLE_RATE_HZ) * 1000),
      userRecorderOffsetBytes,
      userRecorderByteLength: 0,
      audioEndedAtMs: 0,
      speechEndedAtMs: 0,
      sttFinalAtMs: 0,
      firstAgentAtMs: 0,
      firstAudioAtMs: 0,
      ttsEndedAtMs: 0,
      sttTranscript: "",
      agentReply: "",
      spokenReply: "",
      toolCalls: [],
      assistantAudioBytes: 0,
      assistantAudioChunks: [],
      error: "",
    };
    const dispose = captureTurn(session, turn);
    console.log(`starting ${turn.id} ${turn.fixtureId}`);
    session.bus.push(Route.Main, {
      kind: "turn.change",
      contextId: turn.id,
      previousContextId: turns.at(-1)?.id ?? "",
      reason: "live_recorder_coherence_smoke",
      timestampMs: Date.now(),
    });
    turn.userRecorderByteLength += await sendPcmFrames(session, samples, turn.id);
    turn.audioEndedAtMs = Date.now();
    turn.userRecorderByteLength += await sendSilence(session, turn.id, POST_USER_SILENCE_MS);
    await waitForTurnComplete(turn);
    await sleep(POST_TTS_DRAIN_MS);
    dispose();
    console.log(`completed ${turn.id}: ${turn.sttTranscript.slice(0, 90)}`);
    turns.push(turn);
    userRecorderOffsetBytes += turn.userRecorderByteLength;
  }
  return turns;
}

function captureTurn(session: ReturnType<typeof createUniversitySupportSession>, turn: TurnCapture): () => void {
  const offStt = session.bus.on("stt.result", (pkt) => {
    const stt = pkt as unknown as { contextId: string; text: string; timestampMs: number };
    if (stt.contextId !== turn.id || turn.sttFinalAtMs > 0) return;
    turn.sttTranscript = stt.text;
    turn.sttFinalAtMs = stt.timestampMs;
  });
  const offVad = session.bus.on("vad.speech_ended", (pkt) => {
    const vad = pkt as { contextId: string; timestampMs: number };
    if (vad.contextId === turn.id) turn.speechEndedAtMs = vad.timestampMs;
  });
  const offTtsAudio = session.bus.on<TextToSpeechAudioPacket>("tts.audio", (pkt) => {
    if (pkt.contextId !== turn.id) return;
    if (turn.firstAudioAtMs === 0) turn.firstAudioAtMs = pkt.timestampMs;
    turn.assistantAudioBytes += pkt.audio.byteLength;
    turn.assistantAudioChunks.push(Uint8Array.from(pkt.audio));
  });
  const offTtsEnd = session.bus.on<TextToSpeechEndPacket>("tts.end", (pkt) => {
    if (pkt.contextId === turn.id) turn.ttsEndedAtMs = pkt.timestampMs;
  });
  const offTtsText = session.bus.on("tts.text", (pkt) => {
    const tts = pkt as unknown as { contextId: string; text: string };
    if (tts.contextId === turn.id) turn.spokenReply += tts.text;
  });
  const onAgentDelta = (event: { tsMs: number; turnId: string; delta: string }) => {
    if (event.turnId !== turn.id) return;
    if (turn.firstAgentAtMs === 0) turn.firstAgentAtMs = event.tsMs;
    turn.agentReply += event.delta;
  };
  const onToolCall = (event: { turnId: string; name: string }) => {
    if (event.turnId === turn.id) turn.toolCalls.push(event.name);
  };
  const onError = (event: { stage: string; category: string; message: string }) => {
    turn.error = `${event.stage}/${event.category}: ${event.message}`;
  };
  session.on("agent_text_delta", onAgentDelta);
  session.on("agent_tool_call", onToolCall);
  session.on("error", onError);
  return () => {
    offStt();
    offVad();
    offTtsAudio();
    offTtsEnd();
    offTtsText();
    session.off("agent_text_delta", onAgentDelta);
    session.off("agent_tool_call", onToolCall);
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
    sendAudioFrame(session, frame, contextId);
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
    sendAudioFrame(session, frame, contextId);
    byteLength += frame.byteLength;
    await sleep(20);
  }
  return byteLength;
}

function sendAudioFrame(
  session: ReturnType<typeof createUniversitySupportSession>,
  frame: Int16Array,
  contextId: string,
): void {
  session.bus.push(Route.Main, {
    kind: "user.audio_received",
    contextId,
    timestampMs: Date.now(),
    audio: new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength),
  });
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
  throw new Error(
    `turn timeout ${turn.id}: ` +
      `stt=${String(turn.sttFinalAtMs > 0)} ` +
      `vadEnd=${String(turn.speechEndedAtMs > 0)} ` +
      `agent=${String(turn.firstAgentAtMs > 0)} ` +
      `audio=${String(turn.firstAudioAtMs > 0)} ` +
      `ttsEnd=${String(turn.ttsEndedAtMs > 0)} ` +
      `transcript=${JSON.stringify(turn.sttTranscript)} ` +
      `reply=${JSON.stringify(turn.agentReply)}`,
  );
}

function evaluateQuality(
  turns: readonly TurnCapture[],
  recorderManifest: RecorderManifest,
  recorderUserTranscript: string,
  recorderAssistantTranscript: string,
): string[] {
  const failures: string[] = [];
  if (turns.length !== TURN_COUNT) failures.push(`expected ${TURN_COUNT} turns, got ${turns.length}`);
  for (const turn of turns) {
    if (turn.toolCalls.length === 0) failures.push(`${turn.id} did not call studentRelationsLookup`);
    if (turn.assistantAudioBytes <= 0) failures.push(`${turn.id} produced no assistant audio`);
    if (!turn.spokenReply.trim()) failures.push(`${turn.id} produced no TTS text`);
    if (turn.spokenReply.trim() && !/[.!?]\s*$/.test(turn.spokenReply.trim())) {
      failures.push(`${turn.id} TTS text did not end cleanly`);
    }
  }
  if (!recorderUserTranscript.trim()) failures.push("recorder user Whisper transcript is empty");
  if (!recorderAssistantTranscript.trim()) failures.push("recorder assistant Whisper transcript is empty");
  if (recorderManifest.audio.user.byteLength <= 0 || recorderManifest.audio.user.chunks <= 0) {
    failures.push("recorder user audio is empty");
  }
  const expectedUserBytes = turns.reduce((sum, turn) => sum + turn.userRecorderByteLength, 0);
  if (recorderManifest.audio.user.byteLength !== expectedUserBytes) {
    failures.push(
      `recorder user audio bytes ${recorderManifest.audio.user.byteLength} did not match turn slices ${expectedUserBytes}`,
    );
  }
  const expectedAssistantBytes = turns.reduce((sum, turn) => sum + turn.assistantAudioBytes, 0);
  if (recorderManifest.audio.assistant.byteLength <= 0 || recorderManifest.audio.assistant.chunks <= 0) {
    failures.push("recorder assistant audio is empty");
  }
  if (recorderManifest.audio.assistant.truncations === 0 && recorderManifest.audio.assistant.byteLength < expectedAssistantBytes) {
    failures.push(
      `recorder assistant audio bytes ${recorderManifest.audio.assistant.byteLength} shorter than turn audio ${expectedAssistantBytes}`,
    );
  }
  if (recorderManifest.audio.assistant.truncations !== 0) {
    failures.push(`expected no assistant truncations, got ${recorderManifest.audio.assistant.truncations}`);
  }
  for (const turn of turns) {
    if (turn.userRecorderByteLength <= 0) failures.push(`${turn.id} recorder user slice is empty`);
    if (turn.assistantAudioChunks.length <= 0) failures.push(`${turn.id} recorder assistant slice is empty`);
  }
  if (recorderManifest.events.packets <= 0) failures.push("recorder events file is empty");
  return failures;
}

export function readRecorderAssistantSampleRateHz(manifest: RecorderManifest): number {
  const sampleRateHz = manifest.audio.assistant.sampleRateHz;
  if (typeof sampleRateHz !== "number" || !Number.isInteger(sampleRateHz) || sampleRateHz <= 0) {
    throw new Error("recorder manifest audio.assistant.sampleRateHz must be a positive integer");
  }
  return sampleRateHz;
}

async function writeTurnRecordings(options: {
  turns: readonly TurnCapture[];
  runDir: string;
  recorderUserPcmPath: string;
  userSampleRateHz: number;
  assistantSampleRateHz: number;
}): Promise<TurnRecordingArtifact[]> {
  const turnDir = join(options.runDir, "turn-recordings");
  await mkdir(turnDir, { recursive: true });
  const userPcm = readFileSync(options.recorderUserPcmPath);
  const artifacts: TurnRecordingArtifact[] = [];
  for (const turn of options.turns) {
    const userSlice = userPcm.subarray(
      turn.userRecorderOffsetBytes,
      turn.userRecorderOffsetBytes + turn.userRecorderByteLength,
    );
    if (userSlice.byteLength !== turn.userRecorderByteLength) {
      throw new Error(
        `${turn.id} recorder user slice expected ${turn.userRecorderByteLength} bytes, got ${userSlice.byteLength}`,
      );
    }
    const assistantSlice = Buffer.concat(turn.assistantAudioChunks.map((chunk) => Buffer.from(chunk)));
    const userWavPath = join(turnDir, `${turn.id}-${turn.fixtureId}-user.wav`);
    const assistantWavPath = join(turnDir, `${turn.id}-${turn.fixtureId}-assistant.wav`);
    await writePcmBufferAsWav(userSlice, userWavPath, options.userSampleRateHz);
    await writePcmBufferAsWav(assistantSlice, assistantWavPath, options.assistantSampleRateHz);
    artifacts.push({
      turnId: turn.id,
      fixtureId: turn.fixtureId,
      userAudioWavPath: relative(PKG_ROOT, userWavPath),
      assistantAudioWavPath: relative(PKG_ROOT, assistantWavPath),
      userDurationMs: Math.round((userSlice.byteLength / 2 / options.userSampleRateHz) * 1000),
      assistantDurationMs: Math.round((assistantSlice.byteLength / 2 / options.assistantSampleRateHz) * 1000),
    });
  }
  return artifacts;
}

async function transcribeWithLocalWhisper(wavPath: string, outputDir: string, id: string): Promise<WhisperResult> {
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
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`local Whisper failed for ${id} with code ${String(code)}: ${stderr}`));
    });
  });
  const jsonPath = join(modelOutputDir, `${basenameWithoutExt(wavPath)}.json`);
  const parsed = JSON.parse(readFileSync(jsonPath, "utf8")) as { text?: string };
  return { text: parsed.text?.trim() ?? "", jsonPath };
}

async function writePcmFileAsWav(inputPath: string, outputPath: string, sampleRateHz: number): Promise<void> {
  const pcm = readFileSync(inputPath);
  await writePcmBufferAsWav(pcm, outputPath, sampleRateHz);
}

async function writePcmBufferAsWav(pcm: Uint8Array, outputPath: string, sampleRateHz: number): Promise<void> {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  const wav = new WaveFile();
  wav.fromScratch(1, sampleRateHz, "16", samples);
  await writeFile(outputPath, Buffer.from(wav.toBuffer()));
}

function ensureLiveEnv(): void {
  const missing: string[] = [];
  if (!process.env["DEEPGRAM_API_KEY"]?.trim()) missing.push("DEEPGRAM_API_KEY");
  if (!process.env["GOOGLE_GENERATIVE_AI_API_KEY"]?.trim()) missing.push("GEMINI_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY");
  if (chooseTtsProvider() === "cartesia" && !process.env["CARTESIA_API_KEY"]?.trim()) missing.push("CARTESIA_API_KEY");
  if (missing.length > 0) throw new Error(`missing live provider env: ${missing.join(", ")}`);
}

function chooseTtsProvider(): UniversitySupportTtsProvider {
  const requested = process.env["SYRINX_REVIEW_TTS"]?.trim().toLowerCase();
  if (requested === "gemini" || requested === "cartesia") return requested;
  return process.env["CARTESIA_API_KEY"]?.trim() ? "cartesia" : "gemini";
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function basenameWithoutExt(path: string): string {
  const base = path.split("/").at(-1) ?? path;
  return base.replace(/\.[^.]+$/, "");
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
