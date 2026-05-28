// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import WebSocket, { type RawData } from "ws";
import { type TextToSpeechAudioPacket, type TextToSpeechEndPacket, type VoiceAgentSession } from "@asyncdot/voice";
import { createVoiceSessionRecorder } from "@asyncdot/voice-recorder";
import {
  createSmartPbxMediaStreamServer,
  createTelnyxMediaStreamServer,
  createTwilioMediaStreamServer,
  decodeMuLawToPcm16,
  encodePcm16ToMuLaw,
  resamplePcm16,
  type SmartPbxMediaStreamServer,
  type TelnyxMediaStreamServer,
  type TwilioMediaStreamServer,
} from "@asyncdot/voice-server-websocket";

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
const ENGINE_SAMPLE_RATE_HZ = 16000;
const PHONE_SAMPLE_RATE_HZ = 8000;
const FRAME_DURATION_MS = 20;
const FRAME_SAMPLES = PHONE_SAMPLE_RATE_HZ * FRAME_DURATION_MS / 1000;
const POST_AUDIO_SILENCE_MS = 5000;
const STREAM_SID = "MZ-university-live-emulated";
const CALL_SID = "CA-university-live-emulated";
const TELNYX_STREAM_ID = "telnyx-university-live-emulated-stream";
const TELNYX_CALL_CONTROL_ID = "telnyx-university-live-emulated-call-control";
const SMARTPBX_CALL_ID = "smartpbx-university-live-emulated-call";
const SMARTPBX_ACCOUNT_ID = "smartpbx-university-live-emulated-account";

type TelephonyProvider = "twilio" | "telnyx" | "smartpbx";
type TelephonyServer = TwilioMediaStreamServer | TelnyxMediaStreamServer | SmartPbxMediaStreamServer;
type NetworkProfile = "clean" | "jittery" | "bursty";

interface TurnCapture {
  readonly id: string;
  readonly fixtureId: string;
  readonly inputText: string;
  readonly inputAudioMs: number;
  audioEndedAtMs: number;
  speechEndedAtMs: number;
  sttFinalAtMs: number;
  firstAgentAtMs: number;
  firstTtsAudioAtMs: number;
  ttsEndedAtMs: number;
  sttTranscript: string;
  agentReply: string;
  spokenReply: string;
  toolCalls: string[];
  assistantAudioBytes: number;
  error: string;
}

interface CarrierCapture {
  networkProfile: NetworkProfile;
  inboundFrames: number;
  inboundWireBytes: number;
  inboundDecodedPcmBytes: number;
  outboundFrames: number;
  outboundWireBytes: number;
  outboundDecodedPcmBytes: number;
  outboundMarks: number;
  outboundEndMarks: number;
  localPlayoutDrains: number;
  firstInboundMediaAfterStartMs: number;
  lastInboundMediaAfterStartMs: number;
  maxInboundMediaGapMs: number;
  firstOutboundMediaAfterStartMs: number;
}

interface CarrierAudioCapture {
  readonly inboundPcm8k: Int16Array[];
  readonly outboundPcm8k: Int16Array[];
}

interface WhisperResult {
  readonly text: string;
  readonly jsonPath: string;
}

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  coerceGoogleGenAiKey();
  ensureLiveEnv();
  await ensureGeminiUniversityFixtures();

  const provider = readProvider();
  const generatedAt = new Date().toISOString();
  const runId = generatedAt.replaceAll(":", "-").replaceAll(".", "-");
  const runDir = join(RUNS_DIR, `telephony-university-live-${provider}-${runId}`);
  const recorderDir = join(runDir, "recorder");
  await mkdir(runDir, { recursive: true });

  const fixture = GEMINI_UNIVERSITY_FIXTURES[0]!;
  const ttsProvider = chooseTtsProvider();
  const assistantSampleRateHz = ttsProvider === "cartesia" ? 16000 : 24000;
  const turn = createTurnCapture(providerContextId(provider), fixture.id, fixture.text, fixture.path);
  const networkProfile = readNetworkProfile();
  const capture = createCarrierCapture(networkProfile);
  const audioCapture = createCarrierAudioCapture();
  const sessions: VoiceAgentSession[] = [];

  const server = await createTelephonyServer(provider, () => {
    const session = createUniversitySupportSession({
      inputSampleRate: ENGINE_SAMPLE_RATE_HZ,
      profile: "interactive",
      ttsProvider,
    });
    session.registerPlugin("recorder", createVoiceSessionRecorder({
      outputDir: recorderDir,
      sessionId: provider,
      userSampleRateHz: ENGINE_SAMPLE_RATE_HZ,
      assistantSampleRateHz,
    }));
    captureTurn(session, turn, capture);
    sessions.push(session);
    return session;
  });

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP websocket address");
  const socket = new WebSocket(`ws://127.0.0.1:${String(address.port)}${providerPath(provider)}`);
  const startedAt = Date.now();

  try {
    socket.on("message", (data, isBinary) => {
      captureOutbound(provider, capture, audioCapture, data, isBinary, startedAt, socket);
    });
    await waitForOpen(socket);
    sendStart(provider, socket);
    await sendFixtureAsPhoneMedia(provider, socket, fixture.path, capture, audioCapture, startedAt);
    turn.audioEndedAtMs = Date.now();
    await sendPhoneSilence(provider, socket, capture, audioCapture, startedAt, POST_AUDIO_SILENCE_MS);
    await waitForTurnComplete(turn, capture);
    await waitForCarrierPlayoutDrain(provider, turn, capture);
  } finally {
    sendStop(provider, socket);
    socket.close();
    await server.close();
    await Promise.all(sessions.map((createdSession) => createdSession.close().catch(() => undefined)));
  }

  const recorderManifestPath = join(recorderDir, provider, "manifest.json");
  const recorderManifest = existsSync(recorderManifestPath)
    ? JSON.parse(readFileSync(recorderManifestPath, "utf8")) as unknown
    : null;
  const carrierInboundWavPath = join(runDir, "carrier-inbound.wav");
  const carrierOutboundWavPath = join(runDir, "carrier-outbound.wav");
  await Promise.all([
    writePcm16Wav(carrierInboundWavPath, mergePcm16(audioCapture.inboundPcm8k), PHONE_SAMPLE_RATE_HZ),
    writePcm16Wav(carrierOutboundWavPath, mergePcm16(audioCapture.outboundPcm8k), PHONE_SAMPLE_RATE_HZ),
  ]);
  const whisperDir = join(runDir, "whisper");
  const [carrierInboundWhisper, carrierOutboundWhisper] = shouldSkipWhisper()
    ? [
        { text: "", jsonPath: "" },
        { text: "", jsonPath: "" },
      ]
    : await Promise.all([
        transcribeWithLocalWhisper(carrierInboundWavPath, whisperDir, "carrier-inbound"),
        transcribeWithLocalWhisper(carrierOutboundWavPath, whisperDir, "carrier-outbound"),
      ]);
  const result = {
    scenario: "telephony_university_live_provider_adapter",
    generatedAt,
    provider,
    transport: `${provider}_media_stream_websocket`,
    fixture: {
      id: fixture.id,
      expectedText: fixture.text,
    },
    sttProvider: "deepgram",
    llmModel: process.env["SYRINX_LLM_MODEL"]?.trim() || DEFAULT_MODEL,
    ttsProvider,
    transcript: {
      sttFinal: turn.sttTranscript,
      agentReply: turn.agentReply,
      spokenTtsReply: turn.spokenReply,
    },
    carrier: capture,
    carrierAudio: {
      inboundWavPath: relative(PKG_ROOT, carrierInboundWavPath),
      outboundWavPath: relative(PKG_ROOT, carrierOutboundWavPath),
      whisperSkipped: shouldSkipWhisper(),
      inboundWhisper: {
        text: carrierInboundWhisper.text,
        jsonPath: carrierInboundWhisper.jsonPath ? relative(PKG_ROOT, carrierInboundWhisper.jsonPath) : "",
      },
      outboundWhisper: {
        text: carrierOutboundWhisper.text,
        jsonPath: carrierOutboundWhisper.jsonPath ? relative(PKG_ROOT, carrierOutboundWhisper.jsonPath) : "",
      },
    },
    recorder: {
      manifestPath: relative(PKG_ROOT, recorderManifestPath),
      manifest: recorderManifest,
    },
    latencyMs: {
      sttFinalAfterAudioEnd: turn.sttFinalAtMs - turn.audioEndedAtMs,
      vadSpeechEndAfterAudioEnd: turn.speechEndedAtMs - turn.audioEndedAtMs,
      llmFirstTextAfterStt: turn.firstAgentAtMs - turn.sttFinalAtMs,
      firstTtsAudioAfterAgentText: turn.firstTtsAudioAtMs - turn.firstAgentAtMs,
      firstCarrierOutboundAfterLastInbound: capture.firstOutboundMediaAfterStartMs - capture.lastInboundMediaAfterStartMs,
      turnWallClock: turn.ttsEndedAtMs - startedAt,
    },
    turn: {
      id: turn.id,
      fixtureId: turn.fixtureId,
      inputAudioMs: turn.inputAudioMs,
      assistantAudioBytes: turn.assistantAudioBytes,
      toolCalls: turn.toolCalls,
    },
    artifacts: {
      runDir: relative(PKG_ROOT, runDir),
      baselinePath: relative(PKG_ROOT, join(runDir, "baseline.json")),
    },
    qualityGate: {
      passed: false,
      failures: [] as string[],
    },
  };
  result.qualityGate.failures = evaluateQuality(turn, capture, recorderManifest, {
    carrierInboundWhisperText: carrierInboundWhisper.text,
    carrierOutboundWhisperText: carrierOutboundWhisper.text,
    whisperSkipped: shouldSkipWhisper(),
  });
  result.qualityGate.passed = result.qualityGate.failures.length === 0;
  await writeFile(join(runDir, "baseline.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(result, null, 2));
  if (result.qualityGate.failures.length > 0) {
    throw new Error(`telephony university live-provider smoke failed: ${result.qualityGate.failures.join("; ")}`);
  }
}

function createTurnCapture(id: string, fixtureId: string, inputText: string, fixturePath: string): TurnCapture {
  const samples = readPcm16Mono16kWav(fixturePath);
  return {
    id,
    fixtureId,
    inputText,
    inputAudioMs: Math.round((samples.length / ENGINE_SAMPLE_RATE_HZ) * 1000),
    audioEndedAtMs: 0,
    speechEndedAtMs: 0,
    sttFinalAtMs: 0,
    firstAgentAtMs: 0,
    firstTtsAudioAtMs: 0,
    ttsEndedAtMs: 0,
    sttTranscript: "",
    agentReply: "",
    spokenReply: "",
    toolCalls: [],
    assistantAudioBytes: 0,
    error: "",
  };
}

function createCarrierCapture(networkProfile: NetworkProfile): CarrierCapture {
  return {
    networkProfile,
    inboundFrames: 0,
    inboundWireBytes: 0,
    inboundDecodedPcmBytes: 0,
    outboundFrames: 0,
    outboundWireBytes: 0,
    outboundDecodedPcmBytes: 0,
    outboundMarks: 0,
    outboundEndMarks: 0,
    localPlayoutDrains: 0,
    firstInboundMediaAfterStartMs: -1,
    lastInboundMediaAfterStartMs: -1,
    maxInboundMediaGapMs: 0,
    firstOutboundMediaAfterStartMs: -1,
  };
}

function createCarrierAudioCapture(): CarrierAudioCapture {
  return {
    inboundPcm8k: [],
    outboundPcm8k: [],
  };
}

async function createTelephonyServer(
  provider: TelephonyProvider,
  createSession: () => VoiceAgentSession,
): Promise<TelephonyServer> {
  if (provider === "twilio") {
    return await createTwilioMediaStreamServer({
      port: 0,
      inputSampleRateHz: ENGINE_SAMPLE_RATE_HZ,
      outputSampleRateHz: ENGINE_SAMPLE_RATE_HZ,
      createSession,
    });
  }
  if (provider === "telnyx") {
    return await createTelnyxMediaStreamServer({
      port: 0,
      inputSampleRateHz: ENGINE_SAMPLE_RATE_HZ,
      outputSampleRateHz: ENGINE_SAMPLE_RATE_HZ,
      bidirectionalCodec: "PCMU",
      createSession,
    });
  }
  return await createSmartPbxMediaStreamServer({
    port: 0,
    inputSampleRateHz: ENGINE_SAMPLE_RATE_HZ,
    outputSampleRateHz: ENGINE_SAMPLE_RATE_HZ,
    createSession,
  });
}

function captureTurn(session: VoiceAgentSession, turn: TurnCapture, capture: CarrierCapture): void {
  session.bus.on("stt.result", (pkt) => {
    const stt = pkt as unknown as { contextId: string; text: string; timestampMs: number };
    if (stt.contextId !== turn.id || turn.sttFinalAtMs > 0) return;
    turn.sttTranscript = stt.text;
    turn.sttFinalAtMs = stt.timestampMs;
  });
  session.bus.on("vad.speech_ended", (pkt) => {
    const vad = pkt as unknown as { contextId: string; timestampMs: number };
    if (vad.contextId === turn.id) turn.speechEndedAtMs = vad.timestampMs;
  });
  session.bus.on<TextToSpeechAudioPacket>("tts.audio", (pkt) => {
    if (pkt.contextId !== turn.id) return;
    if (turn.firstTtsAudioAtMs === 0) turn.firstTtsAudioAtMs = pkt.timestampMs;
    turn.assistantAudioBytes += pkt.audio.byteLength;
  });
  session.bus.on<TextToSpeechEndPacket>("tts.end", (pkt) => {
    if (pkt.contextId === turn.id) turn.ttsEndedAtMs = pkt.timestampMs;
  });
  session.bus.on("tts.text", (pkt) => {
    const tts = pkt as unknown as { contextId: string; text: string };
    if (tts.contextId === turn.id) turn.spokenReply += tts.text;
  });
  session.on("agent_text_delta", (event: { tsMs: number; turnId: string; delta: string }) => {
    if (event.turnId !== turn.id) return;
    if (turn.firstAgentAtMs === 0) turn.firstAgentAtMs = event.tsMs;
    turn.agentReply += event.delta;
  });
  session.on("agent_tool_call", (event: { turnId: string; name: string }) => {
    if (event.turnId === turn.id) turn.toolCalls.push(event.name);
  });
  session.on("error", (event: { stage: string; category: string; message: string }) => {
    turn.error = `${event.stage}/${event.category}: ${event.message}`;
  });
  session.bus.on("metric.conversation", (pkt) => {
    const metric = pkt as unknown as { contextId: string; name: string };
    if (metric.contextId === turn.id && metric.name === "smartpbx.playout_drained") capture.localPlayoutDrains += 1;
  });
}

async function sendFixtureAsPhoneMedia(
  provider: TelephonyProvider,
  socket: WebSocket,
  fixturePath: string,
  capture: CarrierCapture,
  audioCapture: CarrierAudioCapture,
  startedAt: number,
): Promise<void> {
  const audio16k = readPcm16Mono16kWav(fixturePath);
  const audio8k = resamplePcm16(audio16k, ENGINE_SAMPLE_RATE_HZ, PHONE_SAMPLE_RATE_HZ);
  const delays = interFrameDelays(capture.networkProfile);
  let chunk = 1;
  for (let offset = 0; offset < audio8k.length; offset += FRAME_SAMPLES, chunk += 1) {
    const frame = new Int16Array(FRAME_SAMPLES);
    frame.set(audio8k.subarray(offset, Math.min(audio8k.length, offset + FRAME_SAMPLES)));
    sendPhoneFrame(provider, socket, frame, chunk, capture, audioCapture, startedAt);
    await sleep(delays[(chunk - 1) % delays.length] ?? FRAME_DURATION_MS);
  }
}

async function sendPhoneSilence(
  provider: TelephonyProvider,
  socket: WebSocket,
  capture: CarrierCapture,
  audioCapture: CarrierAudioCapture,
  startedAt: number,
  durationMs: number,
): Promise<void> {
  const frames = Math.ceil(durationMs / FRAME_DURATION_MS);
  const silence = new Int16Array(FRAME_SAMPLES);
  for (let i = 0; i < frames; i += 1) {
    sendPhoneFrame(provider, socket, silence, i + 1, capture, audioCapture, startedAt);
    await sleep(FRAME_DURATION_MS);
  }
}

function sendPhoneFrame(
  provider: TelephonyProvider,
  socket: WebSocket,
  frame: Int16Array,
  chunk: number,
  capture: CarrierCapture,
  audioCapture: CarrierAudioCapture,
  startedAt: number,
): void {
  const payload = Buffer.from(encodePcm16ToMuLaw(frame));
  capture.inboundFrames += 1;
  capture.inboundWireBytes += payload.byteLength;
  capture.inboundDecodedPcmBytes += frame.byteLength;
  audioCapture.inboundPcm8k.push(new Int16Array(frame));
  const sentAtMs = Date.now() - startedAt;
  if (capture.firstInboundMediaAfterStartMs < 0) capture.firstInboundMediaAfterStartMs = sentAtMs;
  if (capture.lastInboundMediaAfterStartMs >= 0) {
    capture.maxInboundMediaGapMs = Math.max(capture.maxInboundMediaGapMs, sentAtMs - capture.lastInboundMediaAfterStartMs);
  }
  capture.lastInboundMediaAfterStartMs = sentAtMs;

  if (provider === "twilio") {
    socket.send(JSON.stringify({
      event: "media",
      streamSid: STREAM_SID,
      media: {
        track: "inbound",
        chunk: String(chunk),
        timestamp: String(chunk * FRAME_DURATION_MS),
        payload: payload.toString("base64"),
      },
    }));
    return;
  }
  if (provider === "telnyx") {
    socket.send(JSON.stringify({
      event: "media",
      stream_id: TELNYX_STREAM_ID,
      media: {
        track: "inbound",
        chunk: String(chunk),
        timestamp: String(chunk * FRAME_DURATION_MS),
        payload: payload.toString("base64"),
      },
    }));
    return;
  }
  socket.send(JSON.stringify({
    event: "media",
    media: { payload: payload.toString("base64") },
  }));
}

function captureOutbound(
  provider: TelephonyProvider,
  capture: CarrierCapture,
  audioCapture: CarrierAudioCapture,
  data: RawData,
  isBinary: boolean,
  startedAt: number,
  socket: WebSocket,
): void {
  if (isBinary) return;
  const message = JSON.parse(data.toString()) as {
    event?: string;
    media?: { payload?: string };
    mark?: { name?: string };
  };
  if (message.event === "media" && message.media?.payload) {
    const payload = Buffer.from(message.media.payload, "base64");
    const decoded = decodeMuLawToPcm16(payload);
    capture.outboundFrames += 1;
    capture.outboundWireBytes += payload.byteLength;
    capture.outboundDecodedPcmBytes += decoded.byteLength;
    audioCapture.outboundPcm8k.push(decoded);
    if (capture.firstOutboundMediaAfterStartMs < 0) capture.firstOutboundMediaAfterStartMs = Date.now() - startedAt;
  } else if (message.event === "mark") {
    capture.outboundMarks += 1;
    if (message.mark?.name?.endsWith(":end")) capture.outboundEndMarks += 1;
    if (provider === "twilio") {
      socket.send(JSON.stringify({ event: "mark", streamSid: STREAM_SID, mark: { name: message.mark?.name ?? "" } }));
    } else if (provider === "telnyx") {
      socket.send(JSON.stringify({ event: "mark", stream_id: TELNYX_STREAM_ID, mark: { name: message.mark?.name ?? "" } }));
    }
  }
}

async function waitForTurnComplete(turn: TurnCapture, capture: CarrierCapture): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 180_000) {
    if (turn.error) throw new Error(turn.error);
    if (
      turn.sttFinalAtMs > 0 &&
      turn.speechEndedAtMs > 0 &&
      turn.firstAgentAtMs > 0 &&
      turn.firstTtsAudioAtMs > 0 &&
      turn.ttsEndedAtMs > 0 &&
      capture.outboundFrames > 0
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
      `ttsAudio=${String(turn.firstTtsAudioAtMs > 0)} ` +
      `ttsEnd=${String(turn.ttsEndedAtMs > 0)} ` +
      `carrierOutbound=${String(capture.outboundFrames > 0)} ` +
      `transcript=${JSON.stringify(turn.sttTranscript)} ` +
      `reply=${JSON.stringify(turn.agentReply)}`,
  );
}

async function waitForCarrierPlayoutDrain(
  provider: TelephonyProvider,
  turn: TurnCapture,
  capture: CarrierCapture,
): Promise<void> {
  const expectedWireBytes = expectedPcmuWireBytes(turn.assistantAudioBytes);
  const timeoutMs = Math.max(5000, Math.ceil((expectedWireBytes / PHONE_SAMPLE_RATE_HZ) * 1000) + 5000);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (
      capture.outboundWireBytes >= expectedWireBytes &&
      (provider === "smartpbx" ? capture.localPlayoutDrains > 0 : capture.outboundEndMarks > 0)
    ) {
      return;
    }
    await sleep(100);
  }
  throw new Error(
    `timed out waiting for carrier playout drain: ` +
      `outboundWireBytes=${String(capture.outboundWireBytes)} expectedWireBytes=${String(expectedWireBytes)} ` +
      `outboundEndMarks=${String(capture.outboundEndMarks)} localPlayoutDrains=${String(capture.localPlayoutDrains)}`,
  );
}

function expectedPcmuWireBytes(enginePcm16Bytes: number): number {
  const engineSamples = Math.floor(enginePcm16Bytes / 2);
  return Math.max(0, Math.round((engineSamples * PHONE_SAMPLE_RATE_HZ) / ENGINE_SAMPLE_RATE_HZ));
}

function evaluateQuality(
  turn: TurnCapture,
  capture: CarrierCapture,
  recorderManifest: unknown,
  transcripts: {
    readonly carrierInboundWhisperText: string;
    readonly carrierOutboundWhisperText: string;
    readonly whisperSkipped: boolean;
  },
): string[] {
  const failures: string[] = [];
  if (capture.inboundFrames <= 0) failures.push("carrier inbound media frames were not sent");
  if (capture.outboundFrames <= 0) failures.push("carrier outbound media frames were not produced");
  if (capture.inboundWireBytes <= 0) failures.push("carrier inbound wire audio was empty");
  if (capture.outboundWireBytes <= 0) failures.push("carrier outbound wire audio was empty");
  if (capture.inboundDecodedPcmBytes <= 0) failures.push("carrier inbound decoded PCM was empty");
  if (capture.outboundDecodedPcmBytes <= 0) failures.push("carrier outbound decoded PCM was empty");
  if (capture.outboundMarks > 0 && capture.outboundEndMarks <= 0) failures.push("carrier terminal playback mark was not observed");
  if (capture.outboundMarks === 0 && capture.localPlayoutDrains <= 0) failures.push("local terminal playout drain was not observed");
  if (capture.networkProfile !== "clean" && capture.maxInboundMediaGapMs <= FRAME_DURATION_MS) {
    failures.push(`${capture.networkProfile} network profile did not produce a measurable inbound media gap`);
  }
  if (capture.firstInboundMediaAfterStartMs < 0) failures.push("first inbound media timing was not recorded");
  if (capture.firstOutboundMediaAfterStartMs < 0) failures.push("first outbound media timing was not recorded");
  if (capture.lastInboundMediaAfterStartMs < capture.firstInboundMediaAfterStartMs) {
    failures.push("last inbound media preceded first inbound media");
  }
  if (!turn.sttTranscript.trim()) failures.push("Deepgram final transcript was empty");
  if (!turn.agentReply.trim()) failures.push("Gemini agent reply was empty");
  if (!turn.spokenReply.trim()) failures.push("TTS spoken text was empty");
  if (turn.assistantAudioBytes <= 0) failures.push("TTS audio bytes were empty");
  if (turn.error) failures.push(turn.error);
  if (!transcripts.whisperSkipped && !transcripts.carrierInboundWhisperText.trim()) {
    failures.push("carrier inbound local Whisper transcript was empty");
  }
  if (!transcripts.whisperSkipped && !transcripts.carrierOutboundWhisperText.trim()) {
    failures.push("carrier outbound local Whisper transcript was empty");
  }
  if (recorderManifest === null) failures.push("recorder manifest was not written");
  const recorderTruncations = readRecorderAssistantTruncations(recorderManifest);
  if (recorderTruncations > 0) failures.push(`recorder assistant audio was truncated ${String(recorderTruncations)} time(s)`);
  return failures;
}

function mergePcm16(chunks: readonly Int16Array[]): Int16Array {
  const sampleCount = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Int16Array(sampleCount);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

async function writePcm16Wav(outputPath: string, samples: Int16Array, sampleRateHz: number): Promise<void> {
  const wav = new WaveFile();
  wav.fromScratch(1, sampleRateHz, "16", samples);
  await writeFile(outputPath, Buffer.from(wav.toBuffer()));
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

function shouldSkipWhisper(): boolean {
  const raw = process.env["SYRINX_TELEPHONY_SKIP_WHISPER"]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function readNetworkProfile(): NetworkProfile {
  const raw = (
    process.env["SYRINX_TELEPHONY_NETWORK_PROFILE"]
      ?? process.env["SYRINX_EMULATED_NETWORK_PROFILE"]
  )?.trim().toLowerCase();
  if (!raw || raw === "clean") return "clean";
  if (raw === "jittery" || raw === "bursty") return raw;
  throw new Error(`Unsupported SYRINX_TELEPHONY_NETWORK_PROFILE: ${raw}`);
}

function interFrameDelays(profile: NetworkProfile): readonly number[] {
  if (profile === "jittery") return [35, 5, 45, 10, 30, 15, 20];
  if (profile === "bursty") return [0, 0, 60, 0, 0, 60, 20];
  return [FRAME_DURATION_MS];
}

function basenameWithoutExt(path: string): string {
  const base = path.split("/").at(-1) ?? path;
  return base.replace(/\.[^.]+$/, "");
}

function readRecorderAssistantTruncations(recorderManifest: unknown): number {
  if (!recorderManifest || typeof recorderManifest !== "object") return 0;
  const audio = (recorderManifest as { audio?: unknown }).audio;
  if (!audio || typeof audio !== "object") return 0;
  const assistant = (audio as { assistant?: unknown }).assistant;
  if (!assistant || typeof assistant !== "object") return 0;
  const truncations = (assistant as { truncations?: unknown }).truncations;
  return typeof truncations === "number" && Number.isFinite(truncations) ? truncations : 0;
}

function sendStart(provider: TelephonyProvider, socket: WebSocket): void {
  if (provider === "twilio") {
    socket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    socket.send(JSON.stringify({
      event: "start",
      streamSid: STREAM_SID,
      start: {
        streamSid: STREAM_SID,
        callSid: CALL_SID,
        mediaFormat: { encoding: "audio/x-mulaw", sampleRate: PHONE_SAMPLE_RATE_HZ, channels: 1 },
      },
    }));
    return;
  }
  if (provider === "telnyx") {
    socket.send(JSON.stringify({ event: "connected", version: "1.0.0" }));
    socket.send(JSON.stringify({
      event: "start",
      stream_id: TELNYX_STREAM_ID,
      start: {
        stream_id: TELNYX_STREAM_ID,
        call_control_id: TELNYX_CALL_CONTROL_ID,
        media_format: { encoding: "PCMU", sample_rate: PHONE_SAMPLE_RATE_HZ, channels: 1 },
      },
    }));
    return;
  }
  socket.send(JSON.stringify({
    event: "start",
    start: {
      callId: SMARTPBX_CALL_ID,
      otherLegCallId: "smartpbx-university-live-emulated-peer",
      callerIdNumber: "+94770000000",
      calleeIdNumber: "+94771111111",
      accountId: SMARTPBX_ACCOUNT_ID,
      mediaFormat: { encoding: "g711_ulaw", sampleRate: PHONE_SAMPLE_RATE_HZ },
    },
  }));
}

function sendStop(provider: TelephonyProvider, socket: WebSocket): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (provider === "twilio") {
    socket.send(JSON.stringify({ event: "stop", streamSid: STREAM_SID, stop: { accountSid: "AC-university-live-emulated" } }));
  } else if (provider === "telnyx") {
    socket.send(JSON.stringify({ event: "stop", stream_id: TELNYX_STREAM_ID }));
  } else {
    socket.send(JSON.stringify({ event: "hangup", hangup: { callId: SMARTPBX_CALL_ID, reason: "normal" } }));
  }
}

function providerContextId(provider: TelephonyProvider): string {
  if (provider === "twilio") return `twilio-${CALL_SID}`;
  if (provider === "telnyx") return `telnyx-${TELNYX_CALL_CONTROL_ID}`;
  return `smartpbx-${SMARTPBX_CALL_ID}`;
}

function providerPath(provider: TelephonyProvider): string {
  if (provider === "twilio") return "/twilio";
  if (provider === "telnyx") return "/telnyx";
  return "/media-stream";
}

function readProvider(): TelephonyProvider {
  const raw = process.env["SYRINX_TELEPHONY_PROVIDER"]?.trim().toLowerCase();
  if (!raw || raw === "twilio") return "twilio";
  if (raw === "telnyx" || raw === "smartpbx") return raw;
  throw new Error(`Unsupported SYRINX_TELEPHONY_PROVIDER: ${raw}`);
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

async function waitForOpen(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
