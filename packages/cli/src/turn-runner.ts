// SPDX-License-Identifier: MIT
//
// Provider-agnostic turn driver (LDT-20, revised). This module owns exactly one
// thing: feeding audio into an ALREADY-CONSTRUCTED VoiceAgentSession and
// capturing the transcript/reply/timings/artifacts — never how that session's
// STT/TTS/reasoner plugins got built. The CLI itself must not depend on any
// provider SDK (Deepgram, Cartesia, OpenAI, ...); the caller (the CLI's
// --agent seam, or examples/02-hello-voice-headless's own hardcoded default
// kernel) supplies the session.
//
// examples/02-hello-voice-headless/src/run-one-turn.ts is the other caller: it
// keeps its own `runOneTurn(...)` with the hardcoded Deepgram+OpenAI+Cartesia+
// Silero default (legitimate there — it's an example harness, not a shipped
// CLI) and delegates the actual audio-feed/metrics/event-capture work to
// `driveTurn` here, so there is exactly one implementation of that part.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";

import {
  Route,
  VoiceAgentSession,
  type RecordUserAudioPacket,
  type TextToSpeechAudioPacket,
  type TextToSpeechEndPacket,
  type VoiceAgentSessionEvents,
} from "@kuralle-syrinx/core";

const require = createRequire(import.meta.url);
const { WaveFile } = require("wavefile") as typeof import("wavefile");

const SAMPLES_PER_FRAME = 320;
const DEFAULT_FIXTURE_PATH =
  "/Users/mithushancj/Documents/asyncdot/openscoped/voice-media-transport/research/agents/tests/test_realtime/hello_world.wav";
const DEFAULT_TTS_END_TIMEOUT_MS = 120_000;

/** A pre-built session, or a zero-arg factory producing one — the same contract examples/02-hello-voice-headless/scripts/dev-server.ts's `--agent` seam uses. */
export type SessionFactory = () => VoiceAgentSession | Promise<VoiceAgentSession>;

export interface PerTurnMetrics {
  readonly turnId: string;
  readonly inputAudioMs: number;
  readonly speechEndToFinalTranscriptMs: number;
  readonly speechEndToFirstAudioMs: number;
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
  readonly eventsJsonPath: string;
  readonly transcriptJsonPath: string;
  readonly metricsJsonPath: string;
  readonly metrics: PerTurnMetrics;
  readonly durationMs: number;
}

export interface DriveTurnOptions {
  /** An already-registered VoiceAgentSession, or a factory producing one. Built by the caller — this module never constructs providers. */
  readonly session: VoiceAgentSession | SessionFactory;
  readonly inputWavPath: string;
  readonly sessionDir: string;
  /** Skips WAV read; must be mono 16 kHz PCM decoded samples. */
  readonly syntheticMono16kSamples?: Readonly<Int16Array>;
  readonly realtimePacing?: boolean;
  /** Called once per fed audio frame (including the trailing silence pad), right after it is pushed onto the bus — for a VAD implementation (or a scripted test fake) that needs an explicit per-frame tick outside the bus event flow. */
  readonly onAudioFrame?: (contextId: string) => void;
  /** Called once after all audio (including the silence pad) has been fed, before waiting for tts.end — for an STT implementation (or a scripted test fake) that finalizes on an explicit signal. */
  readonly onAudioFed?: (contextId: string) => void | Promise<void>;
  readonly ttsEndTimeoutMs?: number;
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

/** Resolves a WAV path, falling back to the repo's bundled demo fixture for the literal name "hello.wav" — a convenience inherited from the pre-move script, harmless (and inert) outside this monorepo. */
export function resolveInputWavPath(path: string): string {
  const resolved = resolve(path);
  try {
    readFileSync(resolved);
    return resolved;
  } catch {
    if (basename(path) === "hello.wav") return DEFAULT_FIXTURE_PATH;
    throw new Error(`input WAV not found: ${resolved}`);
  }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function resolveSession(session: VoiceAgentSession | SessionFactory): Promise<VoiceAgentSession> {
  return typeof session === "function" ? session() : session;
}

/**
 * Feed one turn's worth of audio into an already-built session and report the
 * transcript, reply, per-stage timings, and written artifacts. This is the one
 * implementation of "drive a turn" — it knows nothing about which STT/TTS/
 * reasoner backends the session was assembled from.
 */
export async function driveTurn(opts: DriveTurnOptions): Promise<TurnResult> {
  // Resolve (and, if a factory, construct) the session before touching the
  // filesystem: a caller's agent failing to construct is a different failure
  // class (CONFIG) than a bad input file (USAGE/BACKEND), and should surface
  // as itself rather than being masked by a WAV-read error that never got the
  // chance to matter.
  const session = await resolveSession(opts.session);

  const sessionDir = resolve(opts.sessionDir);
  await mkdir(sessionDir, { recursive: true });

  const pcm =
    opts.syntheticMono16kSamples !== undefined
      ? Int16Array.from(opts.syntheticMono16kSamples)
      : readPcm16Mono16kWav(resolveInputWavPath(opts.inputWavPath));

  const contextId = randomUUID();
  const inputChunks: Uint8Array[] = [];
  const outputChunks: Uint8Array[] = [];
  const eventLines: string[] = [];
  const timeline = {
    feedStartMs: 0,
    speechEndMs: 0,
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
  const offTtsAudio = session.bus.on<TextToSpeechAudioPacket>("tts.audio", (pkt) => {
    if (timeline.firstTtsAudioMs === 0) timeline.firstTtsAudioMs = pkt.timestampMs;
    outputChunks.push(pkt.audio);
  });

  const ttsEnd = new Promise<void>((resolveEnd, reject) => {
    const timeout = setTimeout(() => {
      offTtsEnd();
      reject(new Error("tts.end timeout"));
    }, opts.ttsEndTimeoutMs ?? DEFAULT_TTS_END_TIMEOUT_MS);
    const offTtsEnd = session.bus.on<TextToSpeechEndPacket>("tts.end", (pkt) => {
      if (pkt.contextId !== contextId) return;
      clearTimeout(timeout);
      offTtsEnd();
      timeline.ttsEndMs = pkt.timestampMs;
      resolveEnd();
    });
  });

  // `await ttsEnd` sits far below, after the whole feed loop. Anything that throws
  // before it is reached — a plugin failing to initialize, a provider erroring —
  // leaves this promise rejected with nothing attached, and Node reports it as an
  // unhandled rejection with a stack trace, on top of whatever the caller already
  // printed. Marking it handled here changes nothing for `await ttsEnd`, which
  // still observes the rejection: `.catch()` returns a new promise rather than
  // consuming this one. (Same defect and same fix as driveText.)
  void ttsEnd.catch(() => {});

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
    opts.onAudioFrame?.(contextId);
    offset += SAMPLES_PER_FRAME;
    if (opts.realtimePacing === true) await sleep(20);
  }
  timeline.speechEndMs = Date.now();

  for (let pad = 0; pad < 40; pad += 1) {
    const frame = new Int16Array(SAMPLES_PER_FRAME);
    session.bus.push(Route.Main, {
      kind: "user.audio_received",
      contextId,
      timestampMs: Date.now(),
      audio: pcmToBytes(frame),
    });
    opts.onAudioFrame?.(contextId);
    if (opts.realtimePacing === true) await sleep(20);
  }

  await opts.onAudioFed?.(contextId);
  await ttsEnd;

  offRecordUser();
  offTtsAudio();

  const metrics: PerTurnMetrics = {
    turnId: contextId,
    inputAudioMs: Math.round((pcm.length / 16000) * 1000),
    speechEndToFinalTranscriptMs:
      timeline.speechEndMs > 0 && timeline.finalTranscriptMs > 0
        ? Math.max(0, timeline.finalTranscriptMs - timeline.speechEndMs)
        : 0,
    speechEndToFirstAudioMs:
      timeline.speechEndMs > 0 && timeline.firstTtsAudioMs > 0
        ? Math.max(0, timeline.firstTtsAudioMs - timeline.speechEndMs)
        : 0,
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
  const eventsJsonPath = join(sessionDir, "events.json");
  const transcriptJsonPath = join(sessionDir, "transcript.json");
  const metricsJsonPath = join(sessionDir, "metrics.json");
  const events = eventLines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const qualityGate = {
    passed: finalTranscript.trim().length > 0 && agentReply.trim().length > 0 && outputChunks.length > 0,
    failures: [
      ...(finalTranscript.trim().length === 0 ? ["missing final transcript"] : []),
      ...(agentReply.trim().length === 0 ? ["missing agent reply"] : []),
      ...(outputChunks.length === 0 ? ["missing TTS audio"] : []),
    ],
  };

  await writePcm16Wav(inputWavPath, inputChunks, 16000);
  await writePcm16Wav(agentOutWavPath, outputChunks, 16000);
  await writeFile(eventsJsonlPath, eventLines.join(""), "utf8");
  await writeFile(eventsJsonPath, `${JSON.stringify({ events, qualityGate }, null, 2)}\n`, "utf8");
  await writeFile(
    transcriptJsonPath,
    `${JSON.stringify({ finalTranscript, agentReply, turnCount: 1, metrics, qualityGate }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(metricsJsonPath, `${JSON.stringify({ ...metrics, turnCount: 1, qualityGate }, null, 2)}\n`, "utf8");

  await session.close();

  return {
    sessionDir,
    finalTranscript,
    agentReply,
    agentOutWavPath,
    inputWavPath,
    eventsJsonlPath,
    eventsJsonPath,
    transcriptJsonPath,
    metricsJsonPath,
    metrics,
    durationMs:
      timeline.feedStartMs > 0 && timeline.ttsEndMs > 0 ? Math.max(0, timeline.ttsEndMs - timeline.feedStartMs) : 0,
  };
}
