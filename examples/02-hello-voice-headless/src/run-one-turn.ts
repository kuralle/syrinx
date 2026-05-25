// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";
import { WaveFile } from "wavefile";
import {
  VoiceAgentSession,
  type VoiceAgentSessionOptions,
  type PerTurnMetrics,
  createAudioFrame,
  VOICE_PROTOCOL_VERSION,
  type Events,
} from "@asyncdot/voice";
import {
  VoiceSessionRecorder,
  FilesystemBackend,
  type RecordingManifest,
  type RecordingMetadata,
} from "@asyncdot/voice-recorder";

export const DEFAULT_MODEL = "gemini-2.5-flash";

const SAMPLES_PER_FRAME = 320;
const RECORDER_SCHEMA_VERSION = 1;

const DEFAULT_VOICE_ID =
  typeof process.env["CARTESIA_VOICE_ID"] === "string" &&
  process.env["CARTESIA_VOICE_ID"].trim().length > 0
    ? process.env["CARTESIA_VOICE_ID"].trim()
    : "694f9389-aac1-45b6-b726-9d9369183238";

const DEFAULT_SYSTEM_LINES = [
  "You are a helpful voice assistant.",
  "Respond clearly and succinctly.",
] as const;

/** Shape imported by harnesses — keep additive-only; see `ExtendedRunOneTurnOptions` for tests. */
export interface RunOneTurnOptions {
  readonly inputWavPath: string;
  readonly sessionDir: string;
  readonly model?: string;
  readonly voiceId?: string;
  readonly systemPrompt?: string;
}

export interface ExtendedRunOneTurnOptions extends RunOneTurnOptions {
  readonly sessionOverrides?: VoiceAgentSessionOptions;
  /** Skips WAV read — must be mono 16 kHz PCM decoded samples (multiple of 320 not required). */
  readonly syntheticMono16kSamples?: Readonly<Int16Array>;
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
  const repoRoot = resolve(hereDir, "../../../..");
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
  if (!process.env["GOOGLE_GENERATIVE_AI_API_KEY"]?.trim())
    missing.push("GEMINI_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY");
  if (!process.env["CARTESIA_API_KEY"]?.trim()) missing.push("CARTESIA_API_KEY");
  return missing;
}

async function drainAudioOut(session: VoiceAgentSession): Promise<void> {
  const reader = session.audioOut.getReader();
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

function wireRecorderToSession(session: VoiceAgentSession, recorder: VoiceSessionRecorder): () => void {
  const unsubs: Array<() => void> = [];

  const on = <K extends keyof Events>(k: K, fn: Events[K]): void => {
    session.on(k, fn);
    unsubs.push(() => {
      session.off(k, fn);
    });
  };

  on("state_changed", (e) => {
    void recorder.writeRecordedEvent({
      ts: e.tsMs,
      tsMs: e.tsMs,
      kind: "state_changed",
      from: e.from,
      to: e.to,
    });
  });

  on("user_started_speaking", (e) => {
    void recorder.writeRecordedEvent({
      ts: e.tsMs,
      tsMs: e.tsMs,
      kind: "user_started_speaking",
      turnId: e.turnId,
    });
  });

  on("user_stopped_speaking", (e) => {
    void recorder.writeRecordedEvent({
      ts: e.tsMs,
      tsMs: e.tsMs,
      kind: "user_stopped_speaking",
      turnId: e.turnId,
    });
  });

  on("user_input_partial", (e) => {
    void recorder.writeRecordedEvent({
      ts: e.tsMs,
      tsMs: e.tsMs,
      kind: "user_input_partial",
      turnId: e.turnId,
      text: e.text,
    });
  });

  on("user_input_final", (e) => {
    void recorder.writeRecordedEvent({
      ts: e.tsMs,
      tsMs: e.tsMs,
      kind: "user_input_final",
      turnId: e.turnId,
      text: e.text,
      confidence: e.confidence,
    });
  });

  on("end_of_turn_detected", (e) => {
    void recorder.writeRecordedEvent({
      ts: e.tsMs,
      tsMs: e.tsMs,
      kind: "end_of_turn_detected",
      turnId: e.turnId,
      text: e.text,
      ...(e.eotProbability !== undefined ? { eotProbability: e.eotProbability } : {}),
    });
  });

  on("agent_thinking", (e) => {
    void recorder.writeRecordedEvent({
      ts: e.tsMs,
      tsMs: e.tsMs,
      kind: "agent_thinking",
      turnId: e.turnId,
    });
  });

  on("agent_first_token", (e) => {
    void recorder.writeRecordedEvent({
      ts: e.tsMs,
      tsMs: e.tsMs,
      kind: "agent_first_token",
      turnId: e.turnId,
    });
  });

  on("agent_text_delta", (e) => {
    void recorder.writeRecordedEvent({
      ts: e.tsMs,
      tsMs: e.tsMs,
      kind: "agent_text_delta",
      turnId: e.turnId,
      delta: e.delta,
    });
  });

  on("agent_tool_call", (e) => {
    void recorder.writeRecordedEvent({
      ts: e.tsMs,
      tsMs: e.tsMs,
      kind: "agent_tool_call",
      turnId: e.turnId,
      id: e.id,
      name: e.name,
      args: e.args,
    });
  });

  on("agent_tool_result", (e) => {
    void recorder.writeRecordedEvent({
      ts: e.tsMs,
      tsMs: e.tsMs,
      kind: "agent_tool_result",
      turnId: e.turnId,
      id: e.id,
      result: e.result,
      durationMs: e.durationMs,
    });
  });

  on("agent_first_audio", (e) => {
    void recorder.writeRecordedEvent({
      ts: e.tsMs,
      tsMs: e.tsMs,
      kind: "agent_first_audio",
      turnId: e.turnId,
    });
  });

  on("metrics", (e) => {
    void recorder.writeRecordedEvent({
      ts: Date.now(),
      kind: "metrics",
      turnId: e.turnId,
      endpointingMs: e.endpointingMs,
      llmTTFTMs: e.llmTTFTMs,
      ttsTTFBMs: e.ttsTTFBMs,
      e2eLatencyMs: e.e2eLatencyMs,
      agentTokens: e.agentTokens,
      playedMs: e.playedMs,
      truncated: e.truncated,
      toolCalls: e.toolCalls,
    });
  });

  on("agent_finished", (e) => {
    void recorder.writeRecordedEvent({
      ts: e.tsMs,
      tsMs: e.tsMs,
      kind: "agent_finished",
      turnId: e.turnId,
      endpointingMs: e.endpointingMs,
      llmTTFTMs: e.llmTTFTMs,
      ttsTTFBMs: e.ttsTTFBMs,
      e2eLatencyMs: e.e2eLatencyMs,
      agentTokens: e.agentTokens,
      playedMs: e.playedMs,
      truncated: e.truncated,
      toolCalls: e.toolCalls,
    });
  });

  on("interrupted", (e) => {
    void recorder.writeRecordedEvent({
      ts: e.tsMs,
      tsMs: e.tsMs,
      kind: "interrupted",
      turnId: e.turnId,
      reason: e.reason,
    });
  });

  on("error", (e) => {
    const err = e.cause;
    void recorder.writeRecordedEvent({
      ts: Date.now(),
      kind: "error",
      stage: e.stage,
      category: e.category,
      message: err.message,
      name: err.name,
      ...(err.stack !== undefined ? { stack: err.stack } : {}),
    });
  });

  on("closed", (e) => {
    void recorder.writeRecordedEvent({
      ts: e.tsMs,
      tsMs: e.tsMs,
      kind: "closed",
      reason: e.reason,
    });
  });

  return (): void => {
    for (const u of unsubs) u();
  };
}

async function recorderReadyPoll(recorder: VoiceSessionRecorder): Promise<void> {
  if (recorder.state === "recording") return;
  await new Promise<void>((resolve, reject) => {
    let done = false;
    const cleanup = (): void => {
      recorder.off("recorder_started", onStarted);
      recorder.off("recorder_error", onErr);
      clearTimeout(to);
    };
    const finish = (): void => {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    };
    const fail = (err: unknown): void => {
      if (done) return;
      done = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const onStarted = (): void => {
      finish();
    };
    const onErr = (e: { error: Error }): void => {
      fail(e.error);
    };
    recorder.on("recorder_started", onStarted);
    recorder.on("recorder_error", onErr);
    const to = setTimeout(() => fail(new Error("recorder_ready_timeout")), 10_000);
    if (recorder.state === "recording") finish();
  });
}

function encodePcmChunk(frame: Readonly<{ data: Int16Array }>): Buffer {
  const n = frame.data.length;
  const buf = Buffer.allocUnsafe(n * 2);
  for (let i = 0; i < n; i += 1) {
    buf.writeInt16LE(frame.data[i]!, i * 2);
  }
  return buf;
}

function buildManifest(opts: Readonly<{ sessionId: string; iso: string }>): RecordingManifest {
  return {
    recorderSchemaVersion: RECORDER_SCHEMA_VERSION,
    sessionId: opts.sessionId,
    startedAtIsoUtc: opts.iso,
    voiceProtocolVersion: VOICE_PROTOCOL_VERSION,
    kernelVersion: "0.1.0",
    recorderVersion: "0.1.0",
    slots: {
      audioIn: { path: "audio-in.wav", encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 },
      audioOut: { path: "audio-out.wav", encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 },
      events: { path: "events.jsonl", encoding: "ndjson", schemaVersion: 1 },
      transcript: { path: "transcript.json", encoding: "json", schemaVersion: 1 },
      metrics: { path: "metrics.json", encoding: "json", schemaVersion: 1 },
    },
  };
}

function buildMetadata(opts: Readonly<{ sessionId: string; vos: VoiceAgentSessionOptions }>): RecordingMetadata {
  const now = Date.now();
  const t = opts.vos.tuning ?? {};
  const bb = t.backchannelBoundaryMs;
  return {
    sessionId: opts.sessionId,
    startedAtIsoUtc: new Date(now).toISOString(),
    startedAtUnixMs: now,
    pluginLabels: {
      vad: opts.vos.vad.label,
      stt: opts.vos.stt.label,
      tts: opts.vos.tts.label,
      bridge: opts.vos.agent.label,
      turnDetector: "hybrid",
    },
    tuning: {
      endpointingMinDelayMs: t.endpointingMinDelayMs ?? 800,
      endpointingMaxDelayMs: t.endpointingMaxDelayMs ?? 5000,
      aecWarmupMs: t.aecWarmupMs ?? 0,
      interruptionMinDurationMs: t.interruptionMinDurationMs ?? 500,
      interruptionMinWords: t.interruptionMinWords ?? 0,
      backchannelBoundaryMs:
        bb !== undefined ? ([bb[0]!, bb[1]!] as [number, number]) : ([1000, 3500] as [number, number]),
      maxToolSteps: t.maxToolSteps ?? 4,
      preemptiveGeneration: t.preemptiveGeneration ?? true,
      maxTurnWallClockMs: t.maxTurnWallClockMs ?? 30_000,
    },
    transport: { name: "headless-direct", detail: { path: "kernel.audioIn" } },
  };
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
  if (fmt.numChannels !== 1) {
    throw new Error(`expected mono WAV, got ${String(fmt.numChannels)} channels`);
  }
  if (fmt.sampleRate !== 16000) {
    throw new Error(`expected 16 kHz WAV, got ${String(fmt.sampleRate)} Hz`);
  }
  if (fmt.bitsPerSample !== 16 || fmt.audioFormat !== 1) {
    throw new Error("expected 16-bit PCM (format 1) WAV");
  }
  const raw = wav.getSamples(false, Int16Array);
  const mono: Int16Array | undefined = Array.isArray(raw) ? raw[0] : raw;
  if (mono === undefined || !(mono instanceof Int16Array)) {
    throw new Error("WAV has no mono channel samples");
  }
  return mono;
}

function sliceFramePcm(samples: Readonly<Int16Array>, offset: number): Int16Array {
  const end = Math.min(offset + SAMPLES_PER_FRAME, samples.length);
  const sliceLen = end - offset;
  const buf = new Int16Array(SAMPLES_PER_FRAME);
  if (sliceLen > 0) {
    buf.set(samples.subarray(offset, end));
  }
  return buf;
}

async function resolveKernelOptions(ext: ExtendedRunOneTurnOptions): Promise<VoiceAgentSessionOptions> {
  if (ext.sessionOverrides !== undefined) return ext.sessionOverrides;
  const { createLiveSessionOptions } = await import("./live-session-options.js");
  return await createLiveSessionOptions({
    model: ext.model ?? DEFAULT_MODEL,
    voiceId: ext.voiceId ?? DEFAULT_VOICE_ID,
    systemPrompt: ext.systemPrompt ?? DEFAULT_SYSTEM_LINES.join("\n"),
  });
}

export async function runOneTurn(opts: ExtendedRunOneTurnOptions): Promise<TurnResult> {
  const usingTestKernel = opts.sessionOverrides !== undefined;
  if (!usingTestKernel) {
    ensureRepoRootDotenv();
    coerceGoogleGenAiKey();
  }

  const sessionDir = resolve(opts.sessionDir);
  const sessionsRoot = dirname(sessionDir);
  const sessionId = basename(sessionDir);
  await mkdir(sessionsRoot, { recursive: true });

  const pcm: Int16Array =
    opts.syntheticMono16kSamples !== undefined
      ? Int16Array.from(opts.syntheticMono16kSamples)
      : readPcm16Mono16kWav(resolve(opts.inputWavPath));

  const voiceOpts = await resolveKernelOptions(opts);
  const session = new VoiceAgentSession({
    ...voiceOpts,
    tuning: { ...voiceOpts.tuning, aecWarmupMs: voiceOpts.tuning?.aecWarmupMs ?? 0 },
  });

  const fsBackend = new FilesystemBackend({ sessionsRoot });
  const iso = new Date().toISOString();
  const metadata = buildMetadata({ sessionId, vos: voiceOpts });
  const manifest = buildManifest({ sessionId, iso });

  const recorder = new VoiceSessionRecorder({
    id: sessionId,
    backend: fsBackend,
    metadata,
    manifest,
  });

  const offWire = wireRecorderToSession(session, recorder);
  const detachRecorder = session.attachRecorder(recorder);
  await recorderReadyPoll(recorder);

  let finalTranscript = "";
  let agentReply = "";

  session.on("user_input_final", (e) => {
    finalTranscript = e.text;
  });
  session.on("agent_text_delta", (e) => {
    agentReply += e.delta;
  });

  const drainP = drainAudioOut(session);

  const wall = { feedStart: 0, agentDone: 0 };

  const metricsPromise = new Promise<PerTurnMetrics>((resolveMetrics, reject) => {
    const to = setTimeout(() => {
      session.off("agent_finished", onFinish);
      reject(new Error("agent_finished timeout"));
    }, 120_000);
    const onFinish = (
      e: PerTurnMetrics & {
        tsMs: number;
      },
    ): void => {
      clearTimeout(to);
      session.off("agent_finished", onFinish);
      wall.agentDone = Date.now();
      resolveMetrics({
        turnId: e.turnId,
        endpointingMs: e.endpointingMs,
        llmTTFTMs: e.llmTTFTMs,
        ttsTTFBMs: e.ttsTTFBMs,
        e2eLatencyMs: e.e2eLatencyMs,
        agentTokens: e.agentTokens,
        playedMs: e.playedMs,
        truncated: e.truncated,
        toolCalls: e.toolCalls,
      });
    };
    session.on("agent_finished", onFinish);
  });

  await session.start();

  const writer = session.audioIn.getWriter();
  try {
    let offset = 0;
    while (offset < pcm.length) {
      const data = sliceFramePcm(pcm, offset);
      const frame = createAudioFrame({
        data,
        sampleRateHz: 16000,
        durationMs: 20,
        capturedAtMs: Date.now(),
      });
      if (wall.feedStart === 0) wall.feedStart = Date.now();
      await fsBackend.write("audio-in.wav", encodePcmChunk(frame));
      await writer.write(frame);
      offset += SAMPLES_PER_FRAME;
    }

    let pad = 0;
    const maxPad = 800;
    while (pad < maxPad) {
      const data = new Int16Array(SAMPLES_PER_FRAME);
      const frame = createAudioFrame({
        data,
        sampleRateHz: 16000,
        durationMs: 20,
        capturedAtMs: Date.now(),
      });
      if (wall.feedStart === 0) wall.feedStart = Date.now();
      await fsBackend.write("audio-in.wav", encodePcmChunk(frame));
      await writer.write(frame);
      pad += 1;
    }
  } finally {
    writer.releaseLock();
  }

  const metrics = await metricsPromise;
  const durationMs =
    wall.feedStart > 0 && wall.agentDone > 0 ? Math.max(0, wall.agentDone - wall.feedStart) : 0;

  await fsBackend.write(
    "transcript.json",
    Buffer.from(`${JSON.stringify({ finalTranscript, agentReply, metrics }, null, 2)}\n`, "utf8"),
  );

  offWire();
  await detachRecorder();
  await session.close();
  await drainP;

  return {
    sessionDir,
    finalTranscript,
    agentReply,
    agentOutWavPath: resolve(sessionDir, "audio-out.wav"),
    inputWavPath: resolve(sessionDir, "audio-in.wav"),
    eventsJsonlPath: resolve(sessionDir, "events.jsonl"),
    transcriptJsonPath: resolve(sessionDir, "transcript.json"),
    metricsJsonPath: resolve(sessionDir, "metrics.json"),
    metrics,
    durationMs,
  };
}

export { DEFAULT_VOICE_ID };
