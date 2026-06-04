// SPDX-License-Identifier: MIT

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import WebSocket, { type RawData } from "ws";
import { Decoder as OpusDecoder } from "@evan/opus";

import { decodeSyrinxAudioEnvelope, hasSyrinxAudioEnvelope } from "@asyncdot/voice";
import { pcm16BytesToSamples, pcm16SamplesToBytes, resamplePcm16 } from "@asyncdot/voice/audio";
import { createVoiceWebSocketServer } from "@asyncdot/voice-server-websocket";

import { GEMINI_UNIVERSITY_FIXTURES, PKG_ROOT } from "./generate-gemini-university-fixtures.js";
import { coerceGoogleGenAiKey, ensureRepoRootDotenv, readPcm16Mono16kWav } from "../src/run-one-turn.js";
import { createUniversitySupportSession } from "../src/university-support-agent.js";
import { pcm16DurationMs, writeSmokeArtifactManifest, type SmokeArtifactManifest } from "./smoke-artifact-manifest.js";
import type { UniversitySupportTtsProvider } from "../src/university-support-agent.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = join(SCRIPT_DIR, "..", "test", "performance", "runs");
const BASELINE_PATH = join(SCRIPT_DIR, "..", "test", "performance", "websocket-university-interactive-baseline.json");
const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 16000;
const OPUS_WIRE_SAMPLE_RATE = 48000;
const FRAME_SAMPLES = 320;
const VOICE_TO_VOICE_SLO_MS = 800;
const TRAILING_SILENCE_MS = 1400;
const POST_TTS_DRAIN_MS = 500;

const INTERACTIVE_FIXTURES = [
  {
    id: "review-late-add",
    path: join(SCRIPT_DIR, "..", "test", "fixtures", "university-support-add-drop.wav"),
    text:
      "Hi, I'm Maya Chen, student ID S one zero zero four two. I need to know whether I can still add Biology one oh one after the deadline, and what form I should submit.",
    requiredTerms: ["biology", "add"],
  },
  {
    id: GEMINI_UNIVERSITY_FIXTURES[1]!.id,
    path: GEMINI_UNIVERSITY_FIXTURES[1]!.path,
    text: GEMINI_UNIVERSITY_FIXTURES[1]!.text,
    requiredTerms: ["hold"],
  },
  {
    id: GEMINI_UNIVERSITY_FIXTURES[9]!.id,
    path: GEMINI_UNIVERSITY_FIXTURES[9]!.path,
    text: GEMINI_UNIVERSITY_FIXTURES[9]!.text,
    requiredTerms: ["fee"],
  },
] as const;

interface InteractiveTurnCapture {
  readonly id: string;
  readonly fixtureId: string;
  readonly inputText: string;
  readonly requiredTerms: readonly string[];
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
  audioBytes: number;
  assistantDecodedPcmBytes?: number;
  assistantAudioEncoding: "pcm_s16le" | "opus" | "unknown";
  metricsE2eMs: number;
  error: string;
}

interface ConversationEvaluation {
  readonly failures: string[];
  readonly diagnostics: string[];
}

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  coerceGoogleGenAiKey();
  const ttsProvider = inferTtsProvider();
  requireEnv("DEEPGRAM_API_KEY");
  requireEnv("GOOGLE_GENERATIVE_AI_API_KEY");
  if (ttsProvider === "cartesia") requireEnv("CARTESIA_API_KEY");

  const runId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const runDir = join(RUNS_DIR, `websocket-university-interactive-${runId}`);
  await mkdir(runDir, { recursive: true });

  const server = await createVoiceWebSocketServer({
    port: 0,
    maxQueuedOutputAudioMs: 30_000,
    createSession: () => createUniversitySupportSession({
      inputSampleRate: INPUT_SAMPLE_RATE,
      profile: "interactive",
      ttsProvider,
    }),
    contextId: () => "interactive-bootstrap",
  });

  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP websocket address");
    const socket = await openSocket(`ws://127.0.0.1:${String(address.port)}/ws`);
    const turns = await runConversation(socket);
    socket.close();

    finalizeTurnMetrics(turns);
    const evaluation = evaluateConversation(turns);
    const { failures, diagnostics } = evaluation;
    const manifestPath = join(runDir, "manifest.json");
    const metricsPath = join(runDir, "metrics.json");
    const transcriptPath = join(runDir, "transcript.json");
    const eventsPath = join(runDir, "events.json");
    const sttFinalPool = positiveDeltas(turns, (turn) => turn.sttFinalAtMs - turn.speechEndedAtMs);
    const llmTtftPool = positiveDeltas(turns, (turn) => turn.firstAgentAtMs - turn.sttFinalAtMs);
    const ttsTtfbPool = positiveDeltas(turns, (turn) => turn.firstAudioAtMs - turn.firstAgentAtMs);
    logStagePercentilePool("STT-final", turns, sttFinalPool);
    logStagePercentilePool("LLM-TTFT", turns, llmTtftPool);
    logStagePercentilePool("TTS-TTFB", turns, ttsTtfbPool);
    console.log("playout-start percentiles omitted: no playout-start timestamp captured in InteractiveTurnCapture");
    const baseline = {
      scenario: "websocket_university_student_relations_interactive",
      generatedAt: new Date().toISOString(),
      fixtureProvider: "mixed-wav-fixtures",
      sttModel: process.env["SYRINX_DEEPGRAM_MODEL"]?.trim() || "nova-3",
      llmModel: process.env["SYRINX_LLM_MODEL"]?.trim() || "gemini-3.1-flash-lite",
      ttsProvider,
      ttsModel: ttsProvider === "deepgram"
        ? process.env["SYRINX_DEEPGRAM_TTS_MODEL"]?.trim() || "aura-2-thalia-en"
        : process.env["SYRINX_CARTESIA_MODEL_ID"]?.trim() || "sonic-3",
      region: "unknown",
      transport: "websocket",
      inputSampleRateHz: INPUT_SAMPLE_RATE,
      outputSampleRateHz: OUTPUT_SAMPLE_RATE,
      trailingSilenceMs: TRAILING_SILENCE_MS,
      postTtsDrainMs: POST_TTS_DRAIN_MS,
      turnCount: turns.length,
      latencyMs: {
        avgSttFinalAfterSpeechEnd: average(turns.map((turn) => turn.sttFinalAtMs - turn.audioEndedAtMs)),
        avgVadSpeechEndAfterAudioEnd: average(turns.map((turn) => turn.speechEndedAtMs - turn.audioEndedAtMs)),
        avgLlmTimeToFirstText: average(turns.map((turn) => turn.firstAgentAtMs - turn.sttFinalAtMs)),
        avgTtsTimeToFirstAudio: average(turns.map((turn) => turn.firstAudioAtMs - turn.firstAgentAtMs)),
        avgSpeechEndToFirstAssistantAudio: average(turns.map((turn) => turn.firstAudioAtMs - turn.audioEndedAtMs)),
        avgVadSpeechEndToFirstAssistantAudio: average(turns.map((turn) => turn.firstAudioAtMs - turn.speechEndedAtMs)),
        voiceToVoiceP50Ms: percentile(positiveVoiceToVoiceMs(turns), 50),
        voiceToVoiceP95Ms: percentile(positiveVoiceToVoiceMs(turns), 95),
        voiceToVoiceP99Ms: percentile(positiveVoiceToVoiceMs(turns), 99),
        sttFinalP50Ms: percentile(sttFinalPool, 50),
        sttFinalP95Ms: percentile(sttFinalPool, 95),
        sttFinalP99Ms: percentile(sttFinalPool, 99),
        llmTtftP50Ms: percentile(llmTtftPool, 50),
        llmTtftP95Ms: percentile(llmTtftPool, 95),
        llmTtftP99Ms: percentile(llmTtftPool, 99),
        ttsTtfbP50Ms: percentile(ttsTtfbPool, 50),
        ttsTtfbP95Ms: percentile(ttsTtfbPool, 95),
        ttsTtfbP99Ms: percentile(ttsTtfbPool, 99),
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
        assistantAudioMs: assistantAudioDurationMs(turn),
        audioBytes: turn.audioBytes,
        assistantAudioEncoding: turn.assistantAudioEncoding,
        latencyMs: {
          ...buildTurnLatencyMs(turn),
          voiceToVoiceMs: turn.metricsE2eMs,
        },
      })),
      diagnostics,
      warningGate: buildWarningGate(turns),
      artifacts: {
        runDir: relative(PKG_ROOT, runDir),
        manifestPath: relative(PKG_ROOT, manifestPath),
        metricsPath: relative(PKG_ROOT, metricsPath),
        transcriptPath: relative(PKG_ROOT, transcriptPath),
        eventsPath: relative(PKG_ROOT, eventsPath),
      },
      qualityGate: {
        passed: failures.length === 0,
        failures,
      },
    };
    const manifest = buildSmokeManifest({
      generatedAt: baseline.generatedAt,
      runDir,
      manifestPath,
      failures,
      turns,
    });

    await writeFile(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
    await writeFile(metricsPath, `${JSON.stringify({
      scenario: baseline.scenario,
      generatedAt: baseline.generatedAt,
      turnCount: baseline.turnCount,
      latencyMs: baseline.latencyMs,
      qualityGate: baseline.qualityGate,
      warningGate: baseline.warningGate,
    }, null, 2)}\n`, "utf8");
    await writeFile(transcriptPath, `${JSON.stringify({
      scenario: baseline.scenario,
      generatedAt: baseline.generatedAt,
      turnCount: baseline.turnCount,
      turns: baseline.turns.map((turn) => ({
        id: turn.id,
        fixtureId: turn.fixtureId,
        inputText: turn.inputText,
        sttFinal: turn.sttFinal,
        agentReply: turn.agentReply,
      })),
      qualityGate: baseline.qualityGate,
    }, null, 2)}\n`, "utf8");
    await writeFile(eventsPath, `${JSON.stringify({
      scenario: baseline.scenario,
      generatedAt: baseline.generatedAt,
      turnCount: baseline.turnCount,
      events: buildEvents(turns),
      qualityGate: baseline.qualityGate,
    }, null, 2)}\n`, "utf8");
    await writeSmokeArtifactManifest(manifestPath, manifest);
    console.log(JSON.stringify(baseline, null, 2));
    if (failures.length > 0) throw new Error(`interactive websocket smoke failed: ${failures.join("; ")}`);
  } finally {
    await server.close();
  }
}

function inferTtsProvider(): UniversitySupportTtsProvider {
  const requested = process.env["SYRINX_REVIEW_TTS"]?.trim().toLowerCase();
  if (requested === "deepgram" || requested === "cartesia" || requested === "gemini") return requested;
  return process.env["CARTESIA_API_KEY"]?.trim() ? "cartesia" : "deepgram";
}

function buildWarningGate(turns: readonly InteractiveTurnCapture[]): { readonly passed: boolean; readonly warnings: readonly string[] } {
  const warnings: string[] = [];
  const voiceToVoice = positiveVoiceToVoiceMs(turns);
  const p50 = percentile(voiceToVoice, 50);
  const p95 = percentile(voiceToVoice, 95);
  const p99 = percentile(voiceToVoice, 99);
  if (p50 > VOICE_TO_VOICE_SLO_MS) warnings.push(`voice-to-voice P50 ${String(p50)}ms exceeds ${String(VOICE_TO_VOICE_SLO_MS)}ms SLO band`);
  if (p95 > VOICE_TO_VOICE_SLO_MS) warnings.push(`voice-to-voice P95 ${String(p95)}ms exceeds ${String(VOICE_TO_VOICE_SLO_MS)}ms SLO band`);
  if (p99 > VOICE_TO_VOICE_SLO_MS) warnings.push(`voice-to-voice P99 ${String(p99)}ms exceeds ${String(VOICE_TO_VOICE_SLO_MS)}ms SLO band`);
  return { passed: warnings.length === 0, warnings };
}

function buildEvents(turns: readonly InteractiveTurnCapture[]): Array<Record<string, unknown>> {
  return turns.flatMap((turn) => [
    { turnId: turn.id, kind: "user_audio_started", timestampMs: turn.startedAtMs },
    { turnId: turn.id, kind: "user_audio_ended", timestampMs: turn.audioEndedAtMs },
    { turnId: turn.id, kind: "vad_speech_started", timestampMs: turn.speechStartedAtMs },
    { turnId: turn.id, kind: "vad_speech_ended", timestampMs: turn.speechEndedAtMs },
    { turnId: turn.id, kind: "stt_final", timestampMs: turn.sttFinalAtMs, text: turn.transcript },
    { turnId: turn.id, kind: "agent_first_text", timestampMs: turn.firstAgentAtMs },
    { turnId: turn.id, kind: "tts_first_audio", timestampMs: turn.firstAudioAtMs },
    { turnId: turn.id, kind: "tts_end", timestampMs: turn.ttsEndedAtMs },
  ].filter((event) => typeof event.timestampMs === "number" && event.timestampMs > 0));
}

function buildSmokeManifest(args: {
  readonly generatedAt: string;
  readonly runDir: string;
  readonly manifestPath: string;
  readonly failures: readonly string[];
  readonly turns: readonly InteractiveTurnCapture[];
}): SmokeArtifactManifest {
  const turnArtifacts = args.turns.map((turn) => {
    const inputByteLength = Math.round((turn.inputAudioMs / 1000) * INPUT_SAMPLE_RATE * 2);
    const assistantDecodedPcmBytes = effectiveAssistantDecodedPcmBytes(turn);
    const assistantAudio = turn.assistantAudioEncoding === "opus"
      ? {
          sampleRateHz: OUTPUT_SAMPLE_RATE,
          encoding: "opus" as const,
          channels: 1 as const,
          byteLength: turn.audioBytes,
          wireByteLength: turn.audioBytes,
          decodedPcmByteLength: assistantDecodedPcmBytes,
          durationMs: pcm16DurationMs(assistantDecodedPcmBytes, OUTPUT_SAMPLE_RATE),
        }
      : {
          sampleRateHz: OUTPUT_SAMPLE_RATE,
          encoding: "pcm_s16le" as const,
          channels: 1 as const,
          byteLength: turn.audioBytes,
          durationMs: pcm16DurationMs(turn.audioBytes, OUTPUT_SAMPLE_RATE),
        };
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
      assistantAudio,
      latencyMs: {
        ...buildTurnLatencyMs(turn),
        ...(turn.metricsE2eMs > 0 ? { voiceToVoiceMs: turn.metricsE2eMs } : {}),
      },
      vad: {
        speechStartedCount: turn.speechStartedCount,
        speechEndedCount: turn.speechEndedCount,
      },
    };
  });
  const inputByteLength = turnArtifacts.reduce((sum, turn) => sum + turn.inputAudio.byteLength, 0);
  const outputWireByteLength = turnArtifacts.reduce((sum, turn) => sum + (turn.assistantAudio.wireByteLength ?? turn.assistantAudio.byteLength), 0);
  const outputDecodedPcmByteLength = turnArtifacts.reduce(
    (sum, turn) => sum + (turn.assistantAudio.decodedPcmByteLength ?? turn.assistantAudio.byteLength),
    0,
  );
  const outputDurationMs = turnArtifacts.reduce((sum, turn) => sum + turn.assistantAudio.durationMs, 0);
  return {
    schemaVersion: 2,
    scenario: "websocket_university_student_relations_interactive",
    generatedAt: args.generatedAt,
    transport: "websocket",
    fixtureProvider: "mixed-wav-fixtures",
    run: {
      runDir: relative(PKG_ROOT, args.runDir),
      baselinePath: relative(PKG_ROOT, BASELINE_PATH),
    },
    audio: {
      inputSampleRateHz: INPUT_SAMPLE_RATE,
      outputSampleRateHz: OUTPUT_SAMPLE_RATE,
      inputByteLength,
      outputByteLength: outputWireByteLength,
      inputWireByteLength: inputByteLength,
      outputWireByteLength,
      inputDecodedPcmByteLength: inputByteLength,
      outputDecodedPcmByteLength,
      inputDurationMs: pcm16DurationMs(inputByteLength, INPUT_SAMPLE_RATE),
      outputDurationMs,
    },
    turns: turnArtifacts,
    qualityGate: {
      passed: args.failures.length === 0,
      failures: args.failures,
    },
  };
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

async function runConversation(socket: WebSocket): Promise<InteractiveTurnCapture[]> {
  const turns: InteractiveTurnCapture[] = [];
  const opusDecoder = new OpusDecoder({ channels: 1, sample_rate: OPUS_WIRE_SAMPLE_RATE });
  const maxTurns = Number.parseInt(process.env["SYRINX_WS_MAX_TURNS"] ?? "", 10);
  const fixtures = Number.isFinite(maxTurns) && maxTurns > 0
    ? INTERACTIVE_FIXTURES.slice(0, maxTurns)
    : INTERACTIVE_FIXTURES;

  for (let index = 0; index < fixtures.length; index += 1) {
    const fixture = fixtures[index]!;
    const samples = readPcm16Mono16kWav(fixture.path);
    const turn: InteractiveTurnCapture = {
      id: `interactive-${String(index + 1).padStart(2, "0")}`,
      fixtureId: fixture.id,
      inputText: fixture.text,
      requiredTerms: fixture.requiredTerms,
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
      audioBytes: 0,
      assistantDecodedPcmBytes: 0,
      assistantAudioEncoding: "unknown",
      metricsE2eMs: 0,
      error: "",
    };

    console.log(`starting ${turn.id} ${fixture.id} (${String(turn.inputAudioMs)}ms input)`);
    const dispose = captureTurn(socket, turn, opusDecoder);
    await sendPcmFrames(socket, samples, turn.id);
    turn.audioEndedAtMs = Date.now();
    await sendSilence(socket, turn.id, TRAILING_SILENCE_MS);
    await waitForTurnComplete(turn);
    await sleep(POST_TTS_DRAIN_MS);
    dispose();
    turns.push(turn);
    console.log(
      `completed ${turn.id}: stt=${String(turn.sttFinalAtMs - turn.audioEndedAtMs)}ms ` +
        `llm=${String(turn.firstAgentAtMs - turn.sttFinalAtMs)}ms ` +
        `tts=${String(turn.firstAudioAtMs - turn.firstAgentAtMs)}ms ` +
        `audio=${String(turn.audioBytes)} bytes`,
    );
  }

  return turns;
}

function captureTurn(socket: WebSocket, turn: InteractiveTurnCapture, opusDecoder: OpusDecoder): () => void {
  let nextBinaryBelongsToTurn = false;
  const onMessage = (data: RawData, isBinary: boolean): void => {
    if (isBinary) {
      if (!nextBinaryBelongsToTurn) return;
      nextBinaryBelongsToTurn = false;
      if (turn.firstAudioAtMs === 0) turn.firstAudioAtMs = Date.now();
      const wire = rawBytes(data);
      turn.audioBytes += wire.byteLength;
      accumulateAssistantDecodedPcm(turn, wire, opusDecoder);
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
      if (turn.agentEndedAtMs === 0) turn.agentEndedAtMs = Date.now();
      return;
    }
    if (msg["type"] === "tts_chunk") {
      if (typeof msg["encoding"] === "string") {
        turn.assistantAudioEncoding = msg["encoding"] === "opus" ? "opus" : "pcm_s16le";
      }
      nextBinaryBelongsToTurn = true;
      return;
    }
    if (msg["type"] === "tts_end" && msg["turnId"] === turn.id) {
      turn.ttsEndedAtMs = Date.now();
      return;
    }
    if (msg["type"] === "metrics" && msg["turnId"] === turn.id) return;
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

async function waitForTurnComplete(turn: InteractiveTurnCapture): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 120_000) {
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
      `audioBytes=${String(turn.audioBytes)} ` +
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

export function evaluateConversation(turns: readonly InteractiveTurnCapture[]): ConversationEvaluation {
  const failures: string[] = [];
  const diagnostics: string[] = [];
  if (turns.length === 0) failures.push("no turns completed");
  const avgStt = average(turns.map((turn) => turn.sttFinalAtMs - turn.audioEndedAtMs));
  const avgVadEnd = average(turns.map((turn) => turn.speechEndedAtMs - turn.audioEndedAtMs));
  const avgE2e = average(turns.map((turn) => turn.firstAudioAtMs - turn.audioEndedAtMs));
  const voiceToVoice = turns.map((turn) => turn.metricsE2eMs).filter((value) => value > 0);
  const p50 = percentile(voiceToVoice, 50);
  const p95 = percentile(voiceToVoice, 95);
  const p99 = percentile(voiceToVoice, 99);
  if (p50 > 0) diagnostics.push(`voice-to-voice P50=${String(p50)}ms`);
  if (p95 > 0) diagnostics.push(`voice-to-voice P95=${String(p95)}ms`);
  if (p99 > 0) diagnostics.push(`voice-to-voice P99=${String(p99)}ms`);
  if (p50 > VOICE_TO_VOICE_SLO_MS) {
    diagnostics.push(`voice-to-voice P50 ${String(p50)}ms exceeds ${String(VOICE_TO_VOICE_SLO_MS)}ms SLO band`);
  }
  if (p95 > VOICE_TO_VOICE_SLO_MS) {
    diagnostics.push(`voice-to-voice P95 ${String(p95)}ms exceeds ${String(VOICE_TO_VOICE_SLO_MS)}ms SLO band`);
  }
  if (avgStt > 7000) failures.push(`avg STT final after speech end was ${String(avgStt)}ms, expected <= 7000ms`);
  if (avgVadEnd > 2500) failures.push(`avg VAD speech end after audio end was ${String(avgVadEnd)}ms, expected <= 2500ms`);
  if (avgE2e > 20_000) failures.push(`avg speech end to first assistant audio was ${String(avgE2e)}ms, expected <= 20000ms`);

  for (const turn of turns) {
    const transcript = turn.transcript.toLowerCase();
    const reply = turn.agentReply.toLowerCase();
    if (turn.speechStartedAtMs === 0) failures.push(`${turn.id} did not emit VAD speech_started`);
    if (turn.speechEndedAtMs === 0) failures.push(`${turn.id} did not emit VAD speech_ended`);
    if (turn.speechEndedAtMs < turn.speechStartedAtMs) failures.push(`${turn.id} latest VAD speech_ended preceded first speech_started`);
    for (const term of turn.requiredTerms) {
      if (!transcript.includes(term)) diagnostics.push(`${turn.id} STT transcript missed fixture term ${term}`);
    }
    if (turn.assistantAudioEncoding === "pcm_s16le" && turn.audioBytes < 16_000) {
      failures.push(`${turn.id} returned too little TTS audio`);
    }
    if (turn.assistantAudioEncoding === "opus" && turn.audioBytes < 1_000) {
      failures.push(`${turn.id} returned too little Opus TTS audio`);
    }
    if (turn.speechEndedAtMs > 0 && turn.sttFinalAtMs > 0 && turn.sttFinalAtMs < turn.speechEndedAtMs) {
      failures.push(`${turn.id} STT finalized before VAD speech ended`);
    }
    if (turn.firstAudioAtMs < turn.firstAgentAtMs) failures.push(`${turn.id} received TTS audio before agent text`);
    if (!/[.!?]\s*$/.test(turn.agentReply.trim())) diagnostics.push(`${turn.id} agent reply did not end cleanly`);
    if (reply.length < 30) diagnostics.push(`${turn.id} agent reply was short`);
  }
  return { failures, diagnostics };
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function percentile(values: readonly number[], pct: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
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

function assistantAudioDurationMs(
  turn: Pick<InteractiveTurnCapture, "assistantAudioEncoding" | "audioBytes" | "assistantDecodedPcmBytes">,
): number {
  return pcm16DurationMs(effectiveAssistantDecodedPcmBytes(turn), OUTPUT_SAMPLE_RATE);
}

function effectiveAssistantDecodedPcmBytes(
  turn: Pick<InteractiveTurnCapture, "assistantAudioEncoding" | "audioBytes" | "assistantDecodedPcmBytes">,
): number {
  if (turn.assistantAudioEncoding === "opus") return turn.assistantDecodedPcmBytes ?? 0;
  return turn.audioBytes;
}

function accumulateAssistantDecodedPcm(
  turn: InteractiveTurnCapture,
  wire: Uint8Array,
  opusDecoder: OpusDecoder,
): void {
  if (turn.assistantAudioEncoding === "opus") {
    const pcm48 = pcm16BytesToSamples(opusDecoder.decode(wire));
    const pcm16 = resamplePcm16(pcm48, OPUS_WIRE_SAMPLE_RATE, OUTPUT_SAMPLE_RATE);
    turn.assistantDecodedPcmBytes = (turn.assistantDecodedPcmBytes ?? 0) + pcm16SamplesToBytes(pcm16).byteLength;
    return;
  }
  if (turn.assistantAudioEncoding === "pcm_s16le") {
    turn.assistantDecodedPcmBytes = (turn.assistantDecodedPcmBytes ?? 0) + wire.byteLength;
  }
}

function finalizeTurnMetrics(turns: readonly InteractiveTurnCapture[]): void {
  let excludedVoiceToVoiceTurns = 0;
  for (const turn of turns) {
    const voiceToVoiceMs = turn.firstAudioAtMs - turn.speechEndedAtMs;
    if (voiceToVoiceMs > 0) {
      turn.metricsE2eMs = voiceToVoiceMs;
      continue;
    }
    turn.metricsE2eMs = 0;
    excludedVoiceToVoiceTurns += 1;
  }
  if (excludedVoiceToVoiceTurns > 0) {
    console.log(
      `excluded ${String(excludedVoiceToVoiceTurns)} turn(s) from voice-to-voice percentiles (non-positive canonical v2v)`,
    );
  }
}

function positiveVoiceToVoiceMs(turns: readonly InteractiveTurnCapture[]): number[] {
  return turns.map((turn) => turn.metricsE2eMs).filter((value) => value > 0);
}

function positiveDeltas(
  turns: readonly InteractiveTurnCapture[],
  fn: (turn: InteractiveTurnCapture) => number,
): number[] {
  return turns.map(fn).filter((value) => value > 0);
}

function logStagePercentilePool(
  stage: string,
  turns: readonly InteractiveTurnCapture[],
  pool: readonly number[],
): void {
  const excluded = turns.length - pool.length;
  if (pool.length === 0) {
    console.log(`excluded all ${String(turns.length)} turn(s) from ${stage} percentiles (empty positive pool)`);
    return;
  }
  if (excluded > 0) {
    console.log(`excluded ${String(excluded)} turn(s) from ${stage} percentiles (non-positive ${stage})`);
  }
}

function buildTurnLatencyMs(turn: InteractiveTurnCapture): Record<string, number> {
  const latencyMs: Record<string, number> = {};
  const sttFinalAfterSpeechEnd = turn.sttFinalAtMs - turn.audioEndedAtMs;
  const vadSpeechEndAfterAudioEnd = turn.speechEndedAtMs - turn.audioEndedAtMs;
  const llmTimeToFirstText = turn.firstAgentAtMs - turn.sttFinalAtMs;
  const ttsTimeToFirstAudio = turn.firstAudioAtMs - turn.firstAgentAtMs;
  const speechEndToFirstAssistantAudio = turn.firstAudioAtMs - turn.audioEndedAtMs;
  const vadSpeechEndToFirstAssistantAudio = turn.firstAudioAtMs - turn.speechEndedAtMs;
  const turnWallClock = turn.ttsEndedAtMs - turn.startedAtMs;
  if (sttFinalAfterSpeechEnd >= 0) latencyMs.sttFinalAfterSpeechEnd = sttFinalAfterSpeechEnd;
  if (vadSpeechEndAfterAudioEnd >= 0) latencyMs.vadSpeechEndAfterAudioEnd = vadSpeechEndAfterAudioEnd;
  if (llmTimeToFirstText >= 0) latencyMs.llmTimeToFirstText = llmTimeToFirstText;
  if (ttsTimeToFirstAudio >= 0) latencyMs.ttsTimeToFirstAudio = ttsTimeToFirstAudio;
  if (speechEndToFirstAssistantAudio >= 0) latencyMs.speechEndToFirstAssistantAudio = speechEndToFirstAssistantAudio;
  if (vadSpeechEndToFirstAssistantAudio >= 0) latencyMs.vadSpeechEndToFirstAssistantAudio = vadSpeechEndToFirstAssistantAudio;
  if (turnWallClock >= 0) latencyMs.turnWallClock = turnWallClock;
  return latencyMs;
}

function requireEnv(name: string): void {
  if (!process.env[name]?.trim()) throw new Error(`${name} is required`);
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
