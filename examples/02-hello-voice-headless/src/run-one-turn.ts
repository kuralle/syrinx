// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";
import { WaveFile } from "wavefile";
import {
  Route,
  VoiceAgentSession,
  type PluginConfig,
  type RecordAssistantAudioPacket,
  type RecordUserAudioPacket,
  type TextToSpeechAudioPacket,
  type TextToSpeechEndPacket,
  type VoiceAgentSessionEvents,
  type VoicePlugin,
} from "@asyncdot/voice";
import { AISDKBridgePlugin } from "@asyncdot/voice-bridge-aisdk";
import { DeepgramSTTPlugin } from "@asyncdot/voice-stt-deepgram";
import { CartesiaTTSPlugin } from "@asyncdot/voice-tts-cartesia";
import { SileroVADPlugin } from "@asyncdot/voice-vad-silero";

export const DEFAULT_MODEL = "gemini-2.5-flash";

const SAMPLES_PER_FRAME = 320;
const DEFAULT_FIXTURE_PATH =
  "/Users/mithushancj/Documents/asyncdot/openscoped/voice-media-transport/research/agents/tests/test_realtime/hello_world.wav";

const DEFAULT_VOICE_ID =
  typeof process.env["CARTESIA_VOICE_ID"] === "string" &&
  process.env["CARTESIA_VOICE_ID"].trim().length > 0
    ? process.env["CARTESIA_VOICE_ID"].trim()
    : "694f9389-aac1-45b6-b726-9d9369183238";

const DEFAULT_SYSTEM_LINES = [
  "You are a helpful voice assistant.",
  "Respond clearly and succinctly.",
] as const;

export interface HeadlessSessionOptions {
  readonly plugins: Record<string, VoicePlugin>;
  readonly pluginConfig: Record<string, PluginConfig>;
  readonly sttForceFinalizeTimeoutMs?: number;
}

export interface RunOneTurnOptions {
  readonly inputWavPath: string;
  readonly sessionDir: string;
  readonly model?: string;
  readonly voiceId?: string;
  readonly systemPrompt?: string;
}

export interface ExtendedRunOneTurnOptions extends RunOneTurnOptions {
  readonly sessionOverrides?: HeadlessSessionOptions;
  /** Skips WAV read; must be mono 16 kHz PCM decoded samples. */
  readonly syntheticMono16kSamples?: Readonly<Int16Array>;
}

export interface PerTurnMetrics {
  readonly turnId: string;
  readonly endpointingMs: number;
  readonly llmTTFTMs: number;
  readonly ttsTTFBMs: number;
  readonly e2eLatencyMs: number;
  readonly agentTokens: number;
  readonly playedMs: number;
  readonly truncated: boolean;
  readonly toolCalls: number;
}

export interface TurnResult {
  readonly sessionDir: string;
  readonly finalTranscript: string;
  readonly agentReply: string;
  readonly agentOutWavPath: string;
  readonly inputWavPath: string;
  readonly eventsJsonlPath: string;
  readonly transcriptJsonPath: string;
  readonly metricsJsonPath: string;
  readonly metrics: PerTurnMetrics;
  readonly durationMs: number;
}

let envLoadedFromRoot = false;

export function ensureRepoRootDotenv(): void {
  if (envLoadedFromRoot) return;
  envLoadedFromRoot = true;
  const hereDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(hereDir, "../../..");
  loadDotenv({ path: resolve(repoRoot, ".env") });
}

export function coerceGoogleGenAiKey(): void {
  if (
    !process.env["GOOGLE_GENERATIVE_AI_API_KEY"] &&
    typeof process.env["GEMINI_API_KEY"] === "string" &&
    process.env["GEMINI_API_KEY"].length > 0
  ) {
    process.env["GOOGLE_GENERATIVE_AI_API_KEY"] = process.env["GEMINI_API_KEY"];
  }
}

export function listMissingVoiceHeadlessEnvKeys(): string[] {
  const missing: string[] = [];
  if (!process.env["DEEPGRAM_API_KEY"]?.trim()) missing.push("DEEPGRAM_API_KEY");
  coerceGoogleGenAiKey();
  if (!process.env["GOOGLE_GENERATIVE_AI_API_KEY"]?.trim()) {
    missing.push("GEMINI_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY");
  }
  if (!process.env["CARTESIA_API_KEY"]?.trim()) missing.push("CARTESIA_API_KEY");
  return missing;
}

export function readPcm16Mono16kWav(filePath: string): Int16Array {
  const buf = readFileSync(filePath);
  const wav = new WaveFile(Buffer.from(buf));
  const fmt = wav.fmt as {
    sampleRate: number;
    numChannels: number;
    bitsPerSample: number;
    audioFormat: number;
  };
  if (fmt.numChannels !== 1) throw new Error(`expected mono WAV, got ${String(fmt.numChannels)} channels`);
  if (fmt.bitsPerSample !== 16 || fmt.audioFormat !== 1) throw new Error("expected 16-bit PCM WAV");
  const raw = wav.getSamples(false, Int16Array);
  const mono: Int16Array | undefined = Array.isArray(raw) ? raw[0] : raw;
  if (mono === undefined || !(mono instanceof Int16Array)) throw new Error("WAV has no mono channel samples");
  return fmt.sampleRate === 16000 ? mono : resamplePcm16(mono, fmt.sampleRate, 16000);
}

function resamplePcm16(samples: Int16Array, fromHz: number, toHz: number): Int16Array {
  if (fromHz <= 0 || toHz <= 0) throw new Error("invalid WAV sample rate");
  const outLength = Math.max(1, Math.round((samples.length * toHz) / fromHz));
  const out = new Int16Array(outLength);
  const ratio = fromHz / toHz;
  for (let i = 0; i < out.length; i += 1) {
    const src = i * ratio;
    const lo = Math.floor(src);
    const hi = Math.min(samples.length - 1, lo + 1);
    const frac = src - lo;
    out[i] = Math.round(samples[lo]! * (1 - frac) + samples[hi]! * frac);
  }
  return out;
}

function pcmToBytes(samples: Readonly<Int16Array>): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}

function sliceFramePcm(samples: Readonly<Int16Array>, offset: number): Int16Array {
  const end = Math.min(offset + SAMPLES_PER_FRAME, samples.length);
  const frame = new Int16Array(SAMPLES_PER_FRAME);
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

function eventLine(kind: string, data: Record<string, unknown>): string {
  return `${JSON.stringify({ tsMs: Date.now(), kind, ...data })}\n`;
}

function resolveInputPath(path: string): string {
  const resolved = resolve(path);
  try {
    readFileSync(resolved);
    return resolved;
  } catch {
    if (basename(path) === "hello.wav") return DEFAULT_FIXTURE_PATH;
    throw new Error(`input WAV not found: ${resolved}`);
  }
}

async function resolveKernelOptions(ext: ExtendedRunOneTurnOptions): Promise<HeadlessSessionOptions> {
  if (ext.sessionOverrides !== undefined) return ext.sessionOverrides;

  ensureRepoRootDotenv();
  coerceGoogleGenAiKey();
  const missing = listMissingVoiceHeadlessEnvKeys();
  if (missing.length > 0) throw new Error(`missing live provider env: ${missing.join(", ")}`);

  return {
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
        endpointing: 600,
        model: "nova-2",
        language: "en-US",
      },
      vad: { threshold: 0.01 },
      bridge: {
        api_key: process.env["GOOGLE_GENERATIVE_AI_API_KEY"],
        model: ext.model ?? DEFAULT_MODEL,
        system_prompt: ext.systemPrompt ?? DEFAULT_SYSTEM_LINES.join("\n"),
      },
      tts: {
        api_key: process.env["CARTESIA_API_KEY"],
        voice_id: ext.voiceId ?? DEFAULT_VOICE_ID,
        model_id: "sonic-2-2025-03-07",
        sample_rate: 16000,
        language: "en",
      },
    },
    sttForceFinalizeTimeoutMs: 3500,
  };
}

function callOptionalFrameProcessor(plugin: VoicePlugin | undefined, contextId: string): void {
  const candidate = plugin as { processFrame?: (contextId: string) => void } | undefined;
  candidate?.processFrame?.(contextId);
}

async function callOptionalScriptedStt(plugin: VoicePlugin | undefined, contextId: string): Promise<void> {
  const candidate = plugin as { emitScripted?: (contextId: string) => Promise<void> } | undefined;
  await candidate?.emitScripted?.(contextId);
}

export async function runOneTurn(opts: ExtendedRunOneTurnOptions): Promise<TurnResult> {
  const sessionDir = resolve(opts.sessionDir);
  await mkdir(sessionDir, { recursive: true });

  const pcm =
    opts.syntheticMono16kSamples !== undefined
      ? Int16Array.from(opts.syntheticMono16kSamples)
      : readPcm16Mono16kWav(resolveInputPath(opts.inputWavPath));

  const kernel = await resolveKernelOptions(opts);
  const session = new VoiceAgentSession({
    plugins: kernel.pluginConfig,
    sttForceFinalizeTimeoutMs: kernel.sttForceFinalizeTimeoutMs ?? 3500,
  });
  for (const [name, plugin] of Object.entries(kernel.plugins)) {
    session.registerPlugin(name, plugin);
  }

  const contextId = randomUUID();
  const inputChunks: Uint8Array[] = [];
  const outputChunks: Uint8Array[] = [];
  const eventLines: string[] = [];
  const timeline = {
    feedStartMs: 0,
    finalTranscriptMs: 0,
    firstLlmDeltaMs: 0,
    firstTtsAudioMs: 0,
    ttsEndMs: 0,
  };
  let finalTranscript = "";
  let agentReply = "";
  let toolCalls = 0;

  const offRecordUser = session.bus.on<RecordUserAudioPacket>("record.user_audio", (pkt) => {
    inputChunks.push(pkt.audio);
  });
  const offRecordAssistant = session.bus.on<RecordAssistantAudioPacket>("record.assistant_audio", (pkt) => {
    outputChunks.push(pkt.audio);
  });
  const offTtsAudio = session.bus.on<TextToSpeechAudioPacket>("tts.audio", (pkt) => {
    if (timeline.firstTtsAudioMs === 0) timeline.firstTtsAudioMs = pkt.timestampMs;
  });

  const ttsEnd = new Promise<void>((resolveEnd, reject) => {
    const timeout = setTimeout(() => {
      offTtsEnd();
      reject(new Error("tts.end timeout"));
    }, 120_000);
    const offTtsEnd = session.bus.on<TextToSpeechEndPacket>("tts.end", (pkt) => {
      if (pkt.contextId !== contextId) return;
      clearTimeout(timeout);
      offTtsEnd();
      timeline.ttsEndMs = pkt.timestampMs;
      resolveEnd();
    });
  });

  const on = <K extends keyof VoiceAgentSessionEvents>(event: K, handler: VoiceAgentSessionEvents[K]): void => {
    session.on(event, handler);
  };
  on("user_input_final", (event) => {
    finalTranscript = event.text;
    timeline.finalTranscriptMs = event.tsMs;
    eventLines.push(eventLine("user_input_final", { turnId: event.turnId, text: event.text }));
  });
  on("agent_text_delta", (event) => {
    if (timeline.firstLlmDeltaMs === 0) timeline.firstLlmDeltaMs = event.tsMs;
    agentReply += event.delta;
    eventLines.push(eventLine("agent_text_delta", { turnId: event.turnId, delta: event.delta }));
  });
  on("agent_tool_call", (event) => {
    toolCalls += 1;
    eventLines.push(eventLine("agent_tool_call", { turnId: event.turnId, name: event.name }));
  });
  on("agent_finished", (event) => {
    eventLines.push(eventLine("agent_finished", { turnId: event.turnId }));
  });
  on("error", (event) => {
    eventLines.push(eventLine("error", { stage: event.stage, category: event.category, message: event.message }));
  });

  await session.start();

  session.bus.push(Route.Main, {
    kind: "turn.change",
    contextId,
    previousContextId: "",
    reason: "headless_turn_start",
    timestampMs: Date.now(),
  });

  let offset = 0;
  while (offset < pcm.length) {
    const frame = sliceFramePcm(pcm, offset);
    const audio = pcmToBytes(frame);
    if (timeline.feedStartMs === 0) timeline.feedStartMs = Date.now();
    session.bus.push(Route.Main, {
      kind: "user.audio_received",
      contextId,
      timestampMs: Date.now(),
      audio,
    });
    callOptionalFrameProcessor(kernel.plugins["vad"], contextId);
    offset += SAMPLES_PER_FRAME;
  }

  for (let pad = 0; pad < 40; pad += 1) {
    const frame = new Int16Array(SAMPLES_PER_FRAME);
    session.bus.push(Route.Main, {
      kind: "user.audio_received",
      contextId,
      timestampMs: Date.now(),
      audio: pcmToBytes(frame),
    });
    callOptionalFrameProcessor(kernel.plugins["vad"], contextId);
  }

  await callOptionalScriptedStt(kernel.plugins["stt"], contextId);
  await ttsEnd;

  offRecordUser();
  offRecordAssistant();
  offTtsAudio();

  const metrics: PerTurnMetrics = {
    turnId: contextId,
    endpointingMs:
      timeline.feedStartMs > 0 && timeline.finalTranscriptMs > 0
        ? Math.max(0, timeline.finalTranscriptMs - timeline.feedStartMs)
        : 0,
    llmTTFTMs:
      timeline.finalTranscriptMs > 0 && timeline.firstLlmDeltaMs > 0
        ? Math.max(0, timeline.firstLlmDeltaMs - timeline.finalTranscriptMs)
        : 0,
    ttsTTFBMs:
      timeline.firstLlmDeltaMs > 0 && timeline.firstTtsAudioMs > 0
        ? Math.max(0, timeline.firstTtsAudioMs - timeline.firstLlmDeltaMs)
        : 0,
    e2eLatencyMs:
      timeline.feedStartMs > 0 && timeline.firstTtsAudioMs > 0
        ? Math.max(0, timeline.firstTtsAudioMs - timeline.feedStartMs)
        : 0,
    agentTokens: agentReply.trim().length === 0 ? 0 : agentReply.trim().split(/\s+/).length,
    playedMs: Math.round((mergeBytes(outputChunks).byteLength / 2 / 16000) * 1000),
    truncated: false,
    toolCalls,
  };

  const inputWavPath = join(sessionDir, "audio-in.wav");
  const agentOutWavPath = join(sessionDir, "audio-out.wav");
  const eventsJsonlPath = join(sessionDir, "events.jsonl");
  const transcriptJsonPath = join(sessionDir, "transcript.json");
  const metricsJsonPath = join(sessionDir, "metrics.json");

  await writePcm16Wav(inputWavPath, inputChunks, 16000);
  await writePcm16Wav(agentOutWavPath, outputChunks, 16000);
  await writeFile(eventsJsonlPath, eventLines.join(""), "utf8");
  await writeFile(transcriptJsonPath, `${JSON.stringify({ finalTranscript, agentReply, metrics }, null, 2)}\n`, "utf8");
  await writeFile(metricsJsonPath, `${JSON.stringify(metrics, null, 2)}\n`, "utf8");

  await session.close();

  return {
    sessionDir,
    finalTranscript,
    agentReply,
    agentOutWavPath,
    inputWavPath,
    eventsJsonlPath,
    transcriptJsonPath,
    metricsJsonPath,
    metrics,
    durationMs:
      timeline.feedStartMs > 0 && timeline.ttsEndMs > 0 ? Math.max(0, timeline.ttsEndMs - timeline.feedStartMs) : 0,
  };
}

export { DEFAULT_VOICE_ID };
