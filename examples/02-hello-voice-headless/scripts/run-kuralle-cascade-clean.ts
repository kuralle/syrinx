// SPDX-License-Identifier: MIT
//
// Clean cascaded V2V through the university kuralle session shell (smart-turn EOS
// owns endpointing) with createFullUniversityRuntime as the kuralle brain — same
// RAG+flows+skills stack measured in run-kuralle-cascade-v2v.

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  Route,
  VoiceAgentSession,
  type EndOfSpeechPacket,
  type LlmDeltaPacket,
  type SttResultPacket,
  type TextToSpeechAudioPacket,
  type TextToSpeechEndPacket,
  type VadSpeechEndedPacket,
  type VoicePlugin,
} from "@kuralle-syrinx/core";
import { ReasoningBridge } from "@kuralle-syrinx/aisdk";
import { DeepgramSTTPlugin, DeepgramTTSPlugin } from "@kuralle-syrinx/deepgram";
import { PipecatEOSPlugin } from "@kuralle-syrinx/pipecat-smart-turn";
import { CartesiaTTSPlugin } from "@kuralle-syrinx/cartesia";
import { SileroVADPlugin } from "@kuralle-syrinx/silero-vad";
import { fromKuralleRuntime, type KuralleRuntimeLike } from "@kuralle-syrinx/kuralle";

import {
  coerceGoogleGenAiKey,
  ensureRepoRootDotenv,
  listMissingVoiceHeadlessEnvKeys,
  readPcm16Mono16kWav,
} from "../src/run-one-turn.js";
import {
  createUniversitySupportPluginConfig,
  type UniversitySupportTtsProvider,
} from "../src/university-support-agent.js";
import { createFullUniversityRuntime, type FullUniversityRuntime } from "../src/university-agent-full.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const FIXTURE_PATH = join(PKG_ROOT, "test", "fixtures", "university-support-add-drop.wav");
const REPS = 3;
const INPUT_SAMPLE_RATE_HZ = 16_000;
const FRAME_SAMPLES = 320;
const TRAILING_SILENCE_MS = 1500;
const POST_FEED_SILENCE_MS = 5000;
const TURN_TIMEOUT_MS = 120_000;
const MAX_STT_FINALIZE_MS = 2000;
const ARTIFACT_STT_FINALIZE_MS = 3000;

interface RepCapture {
  readonly rep: number;
  readonly contextId: string;
  vadSpeechEndAtMs: number;
  eosTurnCompleteAtMs: number;
  sttFinalAtMs: number;
  llmFirstAtMs: number;
  ttsFirstAtMs: number;
  ttsEndAtMs: number;
  sttTranscript: string;
  agentReply: string;
  error: string;
}

interface RepMetrics {
  readonly rep: number;
  readonly sttFinalizeMs: number;
  readonly llmTtftMs: number;
  readonly ttsTtfbMs: number;
  readonly v2vMs: number;
  readonly sttTranscript: string;
  readonly agentReply: string;
}

let sharedRuntime: FullUniversityRuntime | null = null;

async function getSharedRuntime(): Promise<FullUniversityRuntime> {
  if (!sharedRuntime) {
    sharedRuntime = await createFullUniversityRuntime();
  }
  return sharedRuntime;
}

function createCleanCascadeSession(
  runtime: FullUniversityRuntime["runtime"],
  sessionId: string,
  userId: string,
): VoiceAgentSession {
  const ttsProvider: UniversitySupportTtsProvider =
    (process.env["SYRINX_REVIEW_TTS"] as UniversitySupportTtsProvider) || "cartesia";
  const pluginConfig = createUniversitySupportPluginConfig({
    inputSampleRate: INPUT_SAMPLE_RATE_HZ,
    profile: "interactive",
    ttsProvider,
  });
  const session = new VoiceAgentSession({
    plugins: pluginConfig,
    idleTimeout: {
      durationMs: 30 * 60_000,
      maxConsecutive: 0,
      disconnectAfterMax: false,
    },
    sttForceFinalizeTimeoutMs: 4_500,
    endpointingOwner: "smart_turn",
    latencyFillerEnabled: false,
  });
  const bridge = new ReasoningBridge(
    fromKuralleRuntime(runtime as unknown as KuralleRuntimeLike, { sessionId, userId }),
  );
  const plugins: Record<string, VoicePlugin> = {
    stt: new DeepgramSTTPlugin(),
    vad: new SileroVADPlugin(),
    eos: new PipecatEOSPlugin(),
    bridge,
    tts: ttsProvider === "deepgram" ? new DeepgramTTSPlugin() : new CartesiaTTSPlugin(),
  };
  for (const [name, plugin] of Object.entries(plugins)) {
    session.registerPlugin(name, plugin);
  }
  return session;
}

function pcmToBytes(samples: Readonly<Int16Array>): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function paddedFixtureSamples(): Int16Array {
  const mono = readPcm16Mono16kWav(FIXTURE_PATH);
  const silence = new Int16Array(Math.round((INPUT_SAMPLE_RATE_HZ * TRAILING_SILENCE_MS) / 1000));
  const out = new Int16Array(mono.length + silence.length);
  out.set(mono, 0);
  out.set(silence, mono.length);
  return out;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
  }
  return sorted[mid]!;
}

function positiveDelta(endMs: number, startMs: number): number {
  if (endMs <= 0 || startMs <= 0 || endMs < startMs) return 0;
  return endMs - startMs;
}

function captureRep(session: VoiceAgentSession, rep: RepCapture): () => void {
  const offVad = session.bus.on("vad.speech_ended", (pkt) => {
    const vad = pkt as VadSpeechEndedPacket;
    if (vad.contextId !== rep.contextId || rep.vadSpeechEndAtMs > 0) return;
    rep.vadSpeechEndAtMs = vad.timestampMs;
  });
  const offEos = session.bus.on("eos.turn_complete", (pkt) => {
    const eos = pkt as EndOfSpeechPacket;
    if (eos.contextId !== rep.contextId || rep.eosTurnCompleteAtMs > 0) return;
    rep.eosTurnCompleteAtMs = eos.timestampMs;
    if (eos.text.trim()) rep.sttTranscript = eos.text;
  });
  const offStt = session.bus.on("stt.result", (pkt) => {
    const stt = pkt as SttResultPacket;
    if (stt.contextId !== rep.contextId) return;
    rep.sttTranscript = stt.text;
    rep.sttFinalAtMs = stt.timestampMs;
  });
  const markLlmFirst = (atMs: number): void => {
    if (rep.llmFirstAtMs === 0) rep.llmFirstAtMs = atMs;
  };
  const offLlm = session.bus.on("llm.delta", (pkt) => {
    const delta = pkt as LlmDeltaPacket;
    if (delta.contextId !== rep.contextId || delta.text.length === 0) return;
    markLlmFirst(delta.timestampMs);
  });
  const offToolCall = session.bus.on("llm.tool_call", (pkt) => {
    const call = pkt as { contextId: string; timestampMs: number };
    if (call.contextId !== rep.contextId) return;
    markLlmFirst(call.timestampMs);
  });
  const offTts = session.bus.on<TextToSpeechAudioPacket>("tts.audio", (pkt) => {
    if (pkt.contextId !== rep.contextId) return;
    if (rep.ttsFirstAtMs === 0) rep.ttsFirstAtMs = pkt.timestampMs;
  });
  const offTtsEnd = session.bus.on<TextToSpeechEndPacket>("tts.end", (pkt) => {
    if (pkt.contextId !== rep.contextId) return;
    rep.ttsEndAtMs = pkt.timestampMs;
  });
  const onAgentDelta = (event: { tsMs: number; turnId: string; delta: string }) => {
    if (event.turnId !== rep.contextId) return;
    markLlmFirst(event.tsMs);
    rep.agentReply += event.delta;
  };
  const onError = (event: { stage: string; category: string; message: string }) => {
    rep.error = `${event.stage}/${event.category}: ${event.message}`;
  };
  session.on("agent_text_delta", onAgentDelta);
  session.on("error", onError);
  return () => {
    offVad();
    offEos();
    offStt();
    offLlm();
    offToolCall();
    offTts();
    offTtsEnd();
    session.off("agent_text_delta", onAgentDelta);
    session.off("error", onError);
  };
}

async function sendPcmFrames(
  session: VoiceAgentSession,
  samples: Int16Array,
  contextId: string,
): Promise<void> {
  for (let offset = 0; offset < samples.length; offset += FRAME_SAMPLES) {
    const frame = new Int16Array(FRAME_SAMPLES);
    frame.set(samples.subarray(offset, Math.min(samples.length, offset + FRAME_SAMPLES)));
    session.bus.push(Route.Main, {
      kind: "user.audio_received",
      contextId,
      timestampMs: Date.now(),
      audio: pcmToBytes(frame),
    });
    await sleep(20);
  }
}

async function sendSilence(session: VoiceAgentSession, contextId: string, durationMs: number): Promise<void> {
  const frames = Math.ceil(durationMs / 20);
  for (let i = 0; i < frames; i += 1) {
    session.bus.push(Route.Main, {
      kind: "user.audio_received",
      contextId,
      timestampMs: Date.now(),
      audio: pcmToBytes(new Int16Array(FRAME_SAMPLES)),
    });
    await sleep(20);
  }
}

async function waitForRep(rep: RepCapture): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < TURN_TIMEOUT_MS) {
    if (rep.error) throw new Error(rep.error);
    if (
      rep.eosTurnCompleteAtMs > 0 &&
      rep.sttFinalAtMs > 0 &&
      rep.llmFirstAtMs > 0 &&
      rep.ttsFirstAtMs > 0 &&
      rep.ttsEndAtMs > 0
    ) {
      return;
    }
    await sleep(50);
  }
  throw new Error(
    `rep ${String(rep.rep)} timeout: eos=${String(rep.eosTurnCompleteAtMs > 0)} ` +
      `stt=${String(rep.sttFinalAtMs > 0)} llm=${String(rep.llmFirstAtMs > 0)} ` +
      `tts=${String(rep.ttsFirstAtMs > 0)} ttsEnd=${String(rep.ttsEndAtMs > 0)}`,
  );
}

function toMetrics(rep: RepCapture): RepMetrics {
  return {
    rep: rep.rep,
    sttFinalizeMs: positiveDelta(rep.sttFinalAtMs, rep.vadSpeechEndAtMs),
    llmTtftMs: positiveDelta(rep.llmFirstAtMs, rep.eosTurnCompleteAtMs),
    ttsTtfbMs: positiveDelta(rep.ttsFirstAtMs, rep.llmFirstAtMs),
    v2vMs: positiveDelta(rep.ttsFirstAtMs, rep.eosTurnCompleteAtMs),
    sttTranscript: rep.sttTranscript,
    agentReply: rep.agentReply,
  };
}

async function runRepOnSession(
  session: VoiceAgentSession,
  repIndex: number,
  samples: Int16Array,
  previousContextId: string,
): Promise<RepMetrics> {
  const contextId = `cascade-clean-rep-${String(repIndex)}`;
  const rep: RepCapture = {
    rep: repIndex,
    contextId,
    vadSpeechEndAtMs: 0,
    eosTurnCompleteAtMs: 0,
    sttFinalAtMs: 0,
    llmFirstAtMs: 0,
    ttsFirstAtMs: 0,
    ttsEndAtMs: 0,
    sttTranscript: "",
    agentReply: "",
    error: "",
  };

  const dispose = captureRep(session, rep);
  try {
    session.bus.push(Route.Main, {
      kind: "turn.change",
      contextId,
      previousContextId,
      reason: "kuralle_cascade_clean",
      timestampMs: Date.now(),
    });
    await sendPcmFrames(session, samples, contextId);
    await sendSilence(session, contextId, POST_FEED_SILENCE_MS);
    await waitForRep(rep);
    await sleep(500);
  } finally {
    dispose();
  }
  return toMetrics(rep);
}

function printTable(reps: readonly RepMetrics[]): void {
  const header = "rep | STT finalize | LLM TTFT | TTS TTFB | V2V (eos→audio)";
  console.log(header);
  console.log("-".repeat(header.length));
  for (const m of reps) {
    console.log(
      `${String(m.rep).padStart(3)} | ` +
        `${String(m.sttFinalizeMs).padStart(12)} ms | ` +
        `${String(m.llmTtftMs).padStart(8)} ms | ` +
        `${String(m.ttsTtfbMs).padStart(8)} ms | ` +
        `${String(m.v2vMs).padStart(6)} ms`,
    );
  }
  console.log(
    `med | ` +
      `${String(median(reps.map((r) => r.sttFinalizeMs))).padStart(12)} ms | ` +
      `${String(median(reps.map((r) => r.llmTtftMs))).padStart(8)} ms | ` +
      `${String(median(reps.map((r) => r.ttsTtfbMs))).padStart(8)} ms | ` +
      `${String(median(reps.map((r) => r.v2vMs))).padStart(6)} ms`,
  );
}

function assertSaneSttFinalize(reps: readonly RepMetrics[]): void {
  const med = median(reps.map((r) => r.sttFinalizeMs));
  if (med >= ARTIFACT_STT_FINALIZE_MS) {
    throw new Error(
      `STT finalize median ${String(med)}ms looks like the bare-harness artifact (≥${String(ARTIFACT_STT_FINALIZE_MS)}ms); ` +
        "smart-turn EOS may not own endpointing",
    );
  }
  if (med > MAX_STT_FINALIZE_MS) {
    throw new Error(`STT finalize median ${String(med)}ms exceeds ${String(MAX_STT_FINALIZE_MS)}ms`);
  }
  for (const m of reps) {
    if (m.sttTranscript.trim().length === 0) {
      throw new Error(`rep ${String(m.rep)}: missing STT transcript`);
    }
    if (m.agentReply.trim().length === 0) {
      throw new Error(`rep ${String(m.rep)}: missing agent reply`);
    }
    if (m.v2vMs === 0) {
      throw new Error(`rep ${String(m.rep)}: missing TTS audio (V2V=0)`);
    }
  }
}

export async function main(): Promise<void> {
  ensureRepoRootDotenv();
  coerceGoogleGenAiKey();
  const missing = listMissingVoiceHeadlessEnvKeys();
  if (missing.length > 0) throw new Error(`missing live provider env: ${missing.join(", ")}`);

  const { runtime, ingestMs } = await getSharedRuntime();
  const samples = paddedFixtureSamples();
  console.log(
    `kuralle cascade clean — smart-turn EOS + full university kuralle brain, ` +
      `fixture=university-support-add-drop.wav, reps=${String(REPS)}, ` +
      `padded=${String(TRAILING_SILENCE_MS)}ms, ingestMs=${String(Math.round(ingestMs))}`,
  );

  const session = createCleanCascadeSession(runtime, "kuralle-cascade-clean", "cascade-clean-smoke");
  await session.start();
  const reps: RepMetrics[] = [];
  try {
    let previousContextId = "";
    for (let i = 1; i <= REPS; i += 1) {
      console.log(`\n--- rep ${String(i)}/${String(REPS)} ---`);
      const metrics = await runRepOnSession(session, i, samples, previousContextId);
      previousContextId = `cascade-clean-rep-${String(i)}`;
      reps.push(metrics);
      console.log(`transcript: ${metrics.sttTranscript}`);
      console.log(`agent reply: ${metrics.agentReply}`);
    }
  } finally {
    await session.close();
  }

  console.log("\n=== per-stage cascade (vad→stt, eos→llm, llm→tts, eos→audio) ===");
  printTable(reps);
  assertSaneSttFinalize(reps);

  const last = reps[reps.length - 1]!;
  console.log("\n=== last rep transcript ===");
  console.log(`user: ${last.sttTranscript}`);
  console.log(`agent: ${last.agentReply}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
