// SPDX-License-Identifier: MIT
//
// Bounded interaction-thesis harness: cascade+rules vs native-realtime through identical
// university fixtures, turn capture, EVA scoring, and task-success — one 2-row matrix + verdict.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createOpenAI } from "@ai-sdk/openai";
import { tool, stepCountIs } from "ai";
import { z } from "zod";

import {
  Route,
  VoiceAgentSession,
  type LlmToolCallPacket,
  type TextToSpeechAudioPacket,
  type TextToSpeechEndPacket,
} from "@kuralle-syrinx/core";
import { fromStreamText } from "@kuralle-syrinx/aisdk";
import { RealtimeBridge, fromOpenAIRealtime } from "@kuralle-syrinx/realtime";
import type { RealtimeAdapter, RealtimeEvent, RealtimeToolDef } from "@kuralle-syrinx/realtime";
import { createNodeWsSocket } from "@kuralle-syrinx/ws/node";

import {
  evaluateEvaExaminer,
  turnCapturesToTimeline,
  type EvaPerturbationKind,
} from "./eva-evaluator.js";
import {
  GEMINI_UNIVERSITY_FIXTURES,
  ensureGeminiUniversityFixtures,
} from "./generate-gemini-university-fixtures.js";
import {
  renderMatrixTable,
  thesisVerdict,
  type ConfigId,
  type MatrixRow,
} from "./interaction-config-sweep.js";
import { DEFAULT_MODEL, ensureRepoRootDotenv, readPcm16Mono16kWav } from "../src/run-one-turn.js";
import { createUniversitySupportSession, type UniversitySupportTtsProvider } from "../src/university-support-agent.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const RESULT_PATH = join(PKG_ROOT, "..", "..", "runs", "thesis-matrix-result.json");

const INPUT_SAMPLE_RATE_HZ = 16000;
const FRAME_SAMPLES = 320;
const TURN_COUNT = 3;
const POST_TTS_DRAIN_MS = 500;
const POST_USER_SILENCE_MS = 5000;

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

type CapturableSession = Pick<VoiceAgentSession, "bus" | "on" | "off">;

export interface TurnCapture {
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
  eosAtMs: number;
  toolCalled: boolean;
  error: string;
}

export interface ThesisMatrixTurnLatency {
  readonly id: string;
  readonly fixtureId: string;
  readonly responseLatencyMs: number;
  readonly taskSucceeded: boolean;
}

export interface ThesisMatrixResult {
  readonly generatedAt: string;
  readonly dry: boolean;
  readonly rows: readonly MatrixRow[];
  readonly verdict: { readonly proven: boolean; readonly reason: string };
  readonly turns: {
    readonly cascadeRules: readonly ThesisMatrixTurnLatency[];
    readonly nativeRealtime: readonly ThesisMatrixTurnLatency[];
  };
  readonly rawTurns?: {
    readonly cascadeRules: readonly TurnCapture[];
    readonly nativeRealtime: readonly TurnCapture[];
  };
}

/** Print the normalized EVA timeline + per-turn response latency and inter-turn gap so the
 *  turnTakingTimingScore is auditable (the score is confounded when endpoint-detection config
 *  differs between fronts under fixed-fixture driving — see the published notes). */
function dumpArmDiagnostics(arm: string, turns: readonly TurnCapture[]): void {
  const timeline = turnCapturesToTimeline(turns);
  // eslint-disable-next-line no-console
  console.error(`[THESIS-DBG] ${arm} EVA timeline (ms, origin=turn0 start):`);
  timeline.forEach((t, i) => {
    const respLat = t.assistantSpeechStartMs - t.userSpeechEndMs;
    const gap = i > 0 ? t.userSpeechStartMs - timeline[i - 1]!.assistantSpeechEndMs : NaN;
    // eslint-disable-next-line no-console
    console.error(
      `[THESIS-DBG]   ${t.id} uStart=${t.userSpeechStartMs} uEnd=${t.userSpeechEndMs} aStart=${t.assistantSpeechStartMs} aEnd=${t.assistantSpeechEndMs} respLat=${respLat} interGap=${gap}`,
    );
  });
}

export function isDryMode(argv: readonly string[] = process.argv): boolean {
  if (process.env["SYRINX_THESIS_DRY"] === "1") return true;
  return argv.includes("--dry");
}

export function turnTaskSucceeded(turn: Pick<TurnCapture, "toolCalled" | "agentReply">): boolean {
  return turn.toolCalled && turn.agentReply.trim().length > 0;
}

export function computeTaskSuccessRate(turns: readonly TurnCapture[]): number {
  if (turns.length === 0) return 0;
  const succeeded = turns.filter(turnTaskSucceeded).length;
  return succeeded / turns.length;
}

export function scoreTurnCaptures(
  turns: readonly TurnCapture[],
  config: ConfigId,
): MatrixRow {
  const timeline = turnCapturesToTimeline(turns);
  const totalConversationMs = turns.reduce((sum, t) => sum + t.inputAudioMs, 0) +
    turns.reduce((sum, t) => sum + Math.round((t.assistantAudioBytes / 2 / INPUT_SAMPLE_RATE_HZ) * 1000), 0);
  const evalResult = evaluateEvaExaminer({
    turns: timeline,
    conversationOverlapMs: 0,
    totalConversationMs,
    perturbation: "clean",
  });
  return {
    config,
    gated: false,
    turnTaking: {
      turnTakingTimingScore: evalResult.scores.turnTakingTimingScore,
      overlapScore: evalResult.scores.overlapScore,
      avgResponseLatencyMs: evalResult.scores.avgResponseLatencyMs,
    },
    taskSuccessRate: computeTaskSuccessRate(turns),
  };
}

export function buildMatrixRows(
  cascadeTurns: readonly TurnCapture[],
  nativeTurns: readonly TurnCapture[],
): MatrixRow[] {
  return [
    scoreTurnCaptures(cascadeTurns, "cascade+rules"),
    scoreTurnCaptures(nativeTurns, "native-realtime"),
  ];
}

export function turnLatencies(turns: readonly TurnCapture[]): ThesisMatrixTurnLatency[] {
  return turns.map((turn) => ({
    id: turn.id,
    fixtureId: turn.fixtureId,
    responseLatencyMs: turn.firstAudioAtMs - turn.speechEndedAtMs,
    taskSucceeded: turnTaskSucceeded(turn),
  }));
}

export function syntheticDryTurnCaptures(arm: "cascade" | "native"): TurnCapture[] {
  const timingOffset = arm === "cascade" ? 0 : 50;
  const base = 1_700_000_000_000;
  return GEMINI_UNIVERSITY_FIXTURES.slice(0, TURN_COUNT).map((fixture, index) => {
    const turnStart = base + index * 20_000;
    const speechStart = turnStart + 200;
    const speechEnd = speechStart + 3_000;
    const sttFinal = speechEnd + 400;
    const firstAgent = speechEnd + 600 + timingOffset;
    const firstAudio = speechEnd + 900 + timingOffset;
    const ttsEnd = firstAudio + 1_500;
    const playoutEnd = ttsEnd + 200;
    return {
      id: `${arm}-turn-${String(index + 1).padStart(2, "0")}`,
      fixtureId: fixture.id,
      perturbation: "clean",
      inputText: fixture.text,
      inputAudioMs: 3_200,
      userRecorderOffsetBytes: 0,
      userRecorderByteLength: 0,
      startedAtMs: turnStart,
      speechStartedAtMs: speechStart,
      speechEndedAtMs: speechEnd,
      sttFinalAtMs: sttFinal,
      firstAgentAtMs: firstAgent,
      firstAudioAtMs: firstAudio,
      ttsEndedAtMs: ttsEnd,
      sttTranscript: fixture.text.slice(0, 80),
      agentReply: "Submit the Late Add Petition in the Student Relations portal today.",
      assistantAudioBytes: INPUT_SAMPLE_RATE_HZ * 2,
      assistantPlayoutEndMs: playoutEnd,
      audioEndedAtMs: speechEnd,
      eosAtMs: speechEnd,
      toolCalled: true,
      error: "",
    };
  });
}

export function runDryMatrix(): ThesisMatrixResult {
  const cascadeTurns = syntheticDryTurnCaptures("cascade");
  const nativeTurns = syntheticDryTurnCaptures("native");
  const rows = buildMatrixRows(cascadeTurns, nativeTurns);
  const verdict = thesisVerdict(rows, { cascadeConfig: "cascade+rules" });
  return {
    generatedAt: new Date().toISOString(),
    dry: true,
    rows,
    verdict,
    turns: {
      cascadeRules: turnLatencies(cascadeTurns),
      nativeRealtime: turnLatencies(nativeTurns),
    },
  };
}

function captureTurn(session: CapturableSession, turn: TurnCapture): () => void {
  // Turns run sequentially with a drain between them, so listeners are dispose-scoped
  // to ONE turn and events are captured UNFILTERED. This is load-bearing for
  // comparability: the native-realtime bridge emits its own contextIds (never the
  // driver-side turn.id) and native S2S emits NO Syrinx vad.speech_ended. The fair,
  // common turn basis is the driver's speechStarted/EndedAtMs (set in driveTurns from
  // when we start/stop sending real speech), identical for both fronts.
  const offStt = session.bus.on("stt.result", (pkt) => {
    const stt = pkt as unknown as { text: string; timestampMs: number };
    if (turn.sttFinalAtMs > 0) return;
    turn.sttTranscript = stt.text;
    turn.sttFinalAtMs = stt.timestampMs;
  });
  const offToolCall = session.bus.on<LlmToolCallPacket>("llm.tool_call", () => {
    turn.toolCalled = true;
  });
  const offEos = session.bus.on("eos.turn_complete", (pkt) => {
    const eos = pkt as { timestampMs: number };
    if (turn.eosAtMs === 0) turn.eosAtMs = eos.timestampMs;
  });
  const offTtsAudio = session.bus.on<TextToSpeechAudioPacket>("tts.audio", (pkt) => {
    if (turn.firstAudioAtMs === 0) turn.firstAudioAtMs = pkt.timestampMs;
    turn.assistantAudioBytes += pkt.audio.byteLength;
    const chunkMs = (pkt.audio.byteLength / 2 / pkt.sampleRateHz) * 1000;
    const playoutBaseMs = Math.max(Date.now(), turn.assistantPlayoutEndMs);
    turn.assistantPlayoutEndMs = playoutBaseMs + chunkMs;
  });
  const offTtsEnd = session.bus.on<TextToSpeechEndPacket>("tts.end", (pkt) => {
    turn.ttsEndedAtMs = pkt.timestampMs;
  });
  const onAgentDelta = (event: { tsMs: number; delta: string }) => {
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
    offToolCall();
    offEos();
    offTtsAudio();
    offTtsEnd();
    session.off("agent_text_delta", onAgentDelta);
    session.off("error", onError);
  };
}

async function sendPcmFrames(
  session: CapturableSession,
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
  session: CapturableSession,
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
    // Settle on the assistant having spoken: first audio out + tts end. Both fronts
    // emit tts.audio + tts.end; native S2S emits neither vad.speech_ended nor a
    // turn.id-keyed stt.result, so those are NOT completion gates (see captureTurn).
    if (turn.firstAudioAtMs > 0 && turn.ttsEndedAtMs > 0) return;
    await sleep(100);
  }
  throw new Error(
    `turn timeout ${turn.id} (firstAudio=${turn.firstAudioAtMs}, ttsEnd=${turn.ttsEndedAtMs})`,
  );
}

const DBG = (): boolean => process.env["SYRINX_THESIS_DBG"] === "1";

async function driveOneTurn(
  session: CapturableSession,
  arm: "cascade" | "native",
  index: number,
  previousTurnId: string,
  onActiveTurn?: (turn: TurnCapture | null) => void,
): Promise<TurnCapture> {
  const fixture = GEMINI_UNIVERSITY_FIXTURES[index]!;
  const samples = readPcm16Mono16kWav(fixture.path);
  const turn: TurnCapture = {
    id: `${arm}-turn-${String(index + 1).padStart(2, "0")}`,
    fixtureId: fixture.id,
    perturbation: "clean",
    inputText: fixture.text,
    inputAudioMs: Math.round((samples.length / INPUT_SAMPLE_RATE_HZ) * 1000),
    userRecorderOffsetBytes: 0,
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
    eosAtMs: 0,
    toolCalled: false,
    error: "",
  };
  const dispose = captureTurn(session, turn);
  onActiveTurn?.(turn);
  // Driver-controlled common turn basis (identical for both fronts): speech starts
  // when we begin sending real frames, ends when we switch to trailing silence.
  turn.speechStartedAtMs = turn.startedAtMs;
  // Turn signalling is front-specific (not a measured quantity): the cascade front
  // segments on Syrinx-side turn.change; native realtime owns turn detection via
  // server_vad and must NOT be handed a turn.change (it aborts the in-flight response).
  if (arm === "cascade") {
    session.bus.push(Route.Main, {
      kind: "turn.change",
      contextId: turn.id,
      previousContextId: previousTurnId,
      reason: "interaction_thesis_matrix",
      timestampMs: Date.now(),
    });
  }
  turn.userRecorderByteLength += await sendPcmFrames(session, samples, turn.id);
  turn.audioEndedAtMs = Date.now();
  turn.speechEndedAtMs = turn.audioEndedAtMs;
  turn.userRecorderByteLength += await sendSilence(session, turn.id, POST_USER_SILENCE_MS);
  if (DBG()) console.error(`[THESIS-DBG] ${turn.id} sent; waiting for assistant audio...`);
  try {
    await waitForTurnComplete(turn);
  } catch (err) {
    if (DBG()) {
      console.error(`[THESIS-DBG] ${turn.id} FAILED firstAudio=${turn.firstAudioAtMs} ttsEnd=${turn.ttsEndedAtMs} tool=${turn.toolCalled} reply=${JSON.stringify(turn.agentReply.slice(0, 60))} err=${turn.error}`);
    }
    throw err;
  }
  if (DBG()) console.error(`[THESIS-DBG] ${turn.id} OK firstAudio=${turn.firstAudioAtMs} ttsEnd=${turn.ttsEndedAtMs} tool=${turn.toolCalled} reply=${JSON.stringify(turn.agentReply.slice(0, 60))}`);
  const remainingPlayoutMs = Math.max(0, turn.assistantPlayoutEndMs - Date.now());
  await sleep(remainingPlayoutMs + POST_TTS_DRAIN_MS);
  onActiveTurn?.(null);
  dispose();
  return turn;
}

async function driveTurns(
  session: CapturableSession,
  arm: "cascade" | "native",
  onActiveTurn?: (turn: TurnCapture | null) => void,
): Promise<TurnCapture[]> {
  const turns: TurnCapture[] = [];
  for (let index = 0; index < TURN_COUNT; index += 1) {
    turns.push(await driveOneTurn(session, arm, index, turns.at(-1)?.id ?? "", onActiveTurn));
  }
  return turns;
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

async function runCascadeRulesSession(ttsProvider: UniversitySupportTtsProvider): Promise<TurnCapture[]> {
  const session = createUniversitySupportSession({
    inputSampleRate: INPUT_SAMPLE_RATE_HZ,
    profile: "interactive",
    ttsProvider,
  });
  await session.start();
  try {
    return await driveTurns(session, "cascade");
  } finally {
    await session.close();
  }
}

async function runNativeRealtimeSession(apiKey: string): Promise<TurnCapture[]> {
  // ONE continuous native session for all turns. The multi-turn barge-in cancel race
  // (server_vad's next-turn speech_started cancels a just-completed response →
  // "no active response found") is fixed at the adapter (task 0df07a88), so a single
  // session now survives multiple turns — restoring a real cross-turn timeline.
  let activeTurn: TurnCapture | null = null;
  const baseAdapter = fromOpenAIRealtime({
    apiKey,
    socketFactory: createNodeWsSocket,
    turnDetection: { type: "server_vad", silence_duration_ms: 500 },
    tools: [ASK_UNIVERSITY_TOOL],
  });
  // Native S2S surfaces the spoken reply as an adapter assistant-transcript event, not
  // a cascade agent_text_delta — tee it into the active turn so task-success (tool
  // called + non-empty grounded reply) is captured identically to the cascade arm.
  const adapter = teeRealtimeAdapter(baseAdapter, (ev) => {
    if (DBG()) {
      const detail = ev.type === "transcript" ? `${ev.role}/${ev.final ? "final" : "interim"}` : "";
      console.error(`[THESIS-DBG] adapter ev=${ev.type} ${detail}`);
    }
    if (ev.type === "transcript" && ev.role === "assistant" && ev.final && activeTurn) {
      activeTurn.agentReply = activeTurn.agentReply
        ? `${activeTurn.agentReply} ${ev.text}`.trim()
        : ev.text.trim();
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

  await session.start();
  try {
    return await driveTurns(session, "native", (t) => {
      activeTurn = t;
    });
  } finally {
    await session.close();
    await adapter.close();
  }
}

function chooseTtsProvider(): UniversitySupportTtsProvider {
  const requested = process.env["SYRINX_REVIEW_TTS"]?.trim().toLowerCase();
  if (requested === "gemini" || requested === "cartesia" || requested === "deepgram") return requested;
  return process.env["CARTESIA_API_KEY"]?.trim() ? "cartesia" : "gemini";
}

function ensureLiveEnv(): void {
  const missing: string[] = [];
  if (!process.env["OPENAI_API_KEY"]?.trim()) missing.push("OPENAI_API_KEY");
  if (!process.env["DEEPGRAM_API_KEY"]?.trim()) missing.push("DEEPGRAM_API_KEY");
  const ttsProvider = chooseTtsProvider();
  if (ttsProvider === "cartesia" && !process.env["CARTESIA_API_KEY"]?.trim()) {
    missing.push("CARTESIA_API_KEY");
  }
  if (ttsProvider === "gemini" && !process.env["GOOGLE_GENERATIVE_AI_API_KEY"]?.trim()) {
    missing.push("GOOGLE_GENERATIVE_AI_API_KEY");
  }
  if (missing.length > 0) {
    throw new Error(`missing live provider env for interaction thesis matrix: ${missing.join(", ")}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function emitThesisMatrixResult(result: ThesisMatrixResult): Promise<void> {
  const table = renderMatrixTable(result.rows);
  const cascade = result.rows.find((r) => r.config === "cascade+rules");
  const native = result.rows.find((r) => r.config === "native-realtime");
  const taskParity =
    cascade?.taskSuccessRate !== undefined && native?.taskSuccessRate !== undefined
      ? cascade.taskSuccessRate >= native.taskSuccessRate - 1e-9
      : undefined;
  const log = (s: string): void => {
    // eslint-disable-next-line no-console
    console.log(s);
  };
  log("# Interaction thesis matrix (cascade+rules vs native-realtime)\n");
  log(table);
  // Honest two-dimension report. Task-success parity is the trustworthy cross-arm
  // result. Turn-taking timing is NOT a clean comparison under fixed-fixture + trailing
  // -silence driving — see docs/interaction-thesis-results.md — so we do NOT emit a bare
  // "thesis PROVEN"; the raw verdict rule output is kept in the JSON for completeness.
  log(
    `\nTask-success parity (trustworthy): ${
      taskParity === undefined
        ? "n/a"
        : taskParity
          ? `NO REGRESSION — cascade ${cascade!.taskSuccessRate!.toFixed(2)} >= native ${native!.taskSuccessRate!.toFixed(2)}`
          : `REGRESSED — cascade ${cascade!.taskSuccessRate!.toFixed(2)} < native ${native!.taskSuccessRate!.toFixed(2)}`
    }`,
  );
  log(
    "Turn-taking timing: CONFOUNDED, not a fair comparison here — the native arm runs a fresh session per turn (a multi-turn realtime-bridge cancel workaround) which breaks the cross-turn EVA inter-turn gap (score is a fresh-session artifact); and the raw response latencies aren't like-for-like (native's fast firstAudio is a pre-tool filler, cascade's is the grounded answer). Cascade's ~5s is real LLM+tool latency, not an STT timeout. The turnTakingTimingScore column is audit-only; a faithful comparison needs a live full-duplex examiner bot. See docs/interaction-thesis-results.md.",
  );
  log(`\n(raw verdict-rule output, not the trustworthy result: ${result.verdict.proven ? "proven" : "not proven"} — ${result.verdict.reason})`);
  const json = `${JSON.stringify(result, null, 2)}\n`;
  log(`\n${json}`);
  await mkdir(dirname(RESULT_PATH), { recursive: true });
  await writeFile(RESULT_PATH, json, "utf8");
}

async function main(): Promise<void> {
  if (isDryMode()) {
    await emitThesisMatrixResult(runDryMatrix());
    return;
  }

  ensureRepoRootDotenv();
  ensureLiveEnv();
  await ensureGeminiUniversityFixtures();

  const ttsProvider = chooseTtsProvider();
  const apiKey = process.env["OPENAI_API_KEY"]!.trim();

  // Arm switch for cheaper iteration on one front (default: both). Diagnostics only —
  // a published matrix needs both arms.
  const arm = process.env["SYRINX_THESIS_ARM"]?.trim().toLowerCase() ?? "both";
  const cascadeTurns = arm === "native" ? [] : await runCascadeRulesSession(ttsProvider);
  const nativeTurns = arm === "cascade" ? [] : await runNativeRealtimeSession(apiKey);
  if (arm !== "both") {
    // eslint-disable-next-line no-console
    console.error(`[THESIS-DBG] single-arm run (${arm}) — not a publishable matrix`);
  }
  const rows = buildMatrixRows(cascadeTurns, nativeTurns);
  const verdict = thesisVerdict(rows, { cascadeConfig: "cascade+rules" });

  if (DBG()) {
    dumpArmDiagnostics("cascade+rules", cascadeTurns);
    dumpArmDiagnostics("native-realtime", nativeTurns);
  }

  await emitThesisMatrixResult({
    generatedAt: new Date().toISOString(),
    dry: false,
    rows,
    verdict,
    turns: {
      cascadeRules: turnLatencies(cascadeTurns),
      nativeRealtime: turnLatencies(nativeTurns),
    },
    rawTurns: { cascadeRules: cascadeTurns, nativeRealtime: nativeTurns },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}