// SPDX-License-Identifier: MIT
//
// Live full-duplex examiner (increment 1): LLM-driven semantic-goal examiner
// against a pluggable voice agent-under-test, ONE continuous session, real
// response-latency + overlap metrics over recorded stereo conversation audio.
//
// No fixed silence pacing — the examiner waits for the agent's real tts.end.
// No fresh-session-per-turn — all turns share one continuous session.
// No fixed script — examiner turns advance by LLM-judged semantic sub-goals.

import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createOpenAI } from "@ai-sdk/openai";
import { generateObject, tool, stepCountIs } from "ai";
import { z } from "zod";

import {
  Route,
  StreamingPcm16Resampler,
  VoiceAgentSession,
  type TextToSpeechAudioPacket,
  type TextToSpeechEndPacket,
} from "@kuralle-syrinx/core";
import { fromStreamText } from "@kuralle-syrinx/aisdk";
import { RealtimeBridge, fromOpenAIRealtime } from "@kuralle-syrinx/realtime";
import type { RealtimeAdapter, RealtimeEvent, RealtimeToolDef } from "@kuralle-syrinx/realtime";
import { createNodeWsSocket } from "@kuralle-syrinx/ws/node";
import { createVoiceSessionRecorder } from "@kuralle-syrinx/recorder";

import { measureStereoOverlapMs } from "./eva-evaluator.js";
import { resolveDailyTask, type DailyTask } from "./examiner-goals.js";
import { ensureRepoRootDotenv, DEFAULT_MODEL } from "../src/run-one-turn.js";
import {
  createUniversitySupportSession,
  type UniversitySupportTtsProvider,
} from "../src/university-support-agent.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentUnderTest {
  readonly session: CapturableSession;
  readonly label: string;
  /** Native-realtime adapter tee writes final assistant transcripts here so
   *  captureAgentResponse can populate agentReply without agent_text_delta. */
  onAssistantTranscript?: ((text: string) => void) | null;
}

/** Minimum surface the examiner uses on the agent session. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface CapturableSession {
  bus: {
    push(route: number, ...packets: any[]): void;
    on(kind: string, handler: (...args: any[]) => void): () => void;
  };
  on(event: string, handler: (...args: any[]) => void): void;
  off(event: string, handler: (...args: any[]) => void): void;
  start(): Promise<void>;
  close(): Promise<void>;
  registerPlugin(name: string, plugin: unknown): void;
}

export interface FdeTurnMetrics {
  readonly turn: number;
  readonly utteranceText: string;
  readonly utteranceEndAtMs: number;
  readonly firstResponseAudioAtMs: number;
  readonly responseEndAtMs: number;
  readonly responseLatencyMs: number;
  readonly agentReply: string;
}

export interface FdeResult {
  readonly task: string;
  readonly taskName: string;
  readonly dry: boolean;
  readonly turns: readonly FdeTurnMetrics[];
  readonly responseLatenciesMs: readonly number[];
  readonly medianResponseLatencyMs: number;
  readonly conversationOverlapMs: number;
  readonly totalTurns: number;
  readonly subGoalsCompleted: boolean;
  readonly maxTurnsReached: boolean;
}

export interface FdeOptions {
  readonly dry: boolean;
  readonly taskName: string;
  readonly maxTurns: number;
  readonly responseTimeoutMs: number;
  readonly outputDir: string;
  readonly recorderDir: string;
  readonly ttsProvider: UniversitySupportTtsProvider;
  readonly examinerModel: string;
  readonly examinerTtsModel: string;
  readonly agentKind: "cascade" | "native";
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const INPUT_SAMPLE_RATE_HZ = 16000;
const FRAME_SAMPLES = 320;
/** Short silence tail so the agent endpointing detects end-of-speech (~800ms). */
const POST_UTTERANCE_SILENCE_MS = 800;
/** Between turns, wait until the agent's audio has been quiet this long (response fully
 *  drained) before the examiner speaks again — correct turn-taking + prevents a long native
 *  reply's tail bleeding into the next turn's capture. Capped so a stuck stream can't hang. */
const RESPONSE_QUIET_MS = 1200;
const RESPONSE_DRAIN_CAP_MS = 25_000;
const DEFAULT_MAX_TURNS = 6;
const DEFAULT_RESPONSE_TIMEOUT_MS = 120_000;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");

// ---------------------------------------------------------------------------
// Agent-under-test factories
// ---------------------------------------------------------------------------

export function cascadeAgent(options: {
  ttsProvider: UniversitySupportTtsProvider;
}): AgentUnderTest {
  const session = createUniversitySupportSession({
    inputSampleRate: INPUT_SAMPLE_RATE_HZ,
    profile: "interactive",
    ttsProvider: options.ttsProvider,
  });
  return { session, label: "cascade+rules" };
}

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

export function nativeRealtimeAgent(apiKey: string): AgentUnderTest {
  const baseAdapter = fromOpenAIRealtime({
    apiKey,
    socketFactory: createNodeWsSocket,
    turnDetection: { type: "server_vad", silence_duration_ms: 500 },
    tools: [ASK_UNIVERSITY_TOOL],
  });

  let onAssistantTranscript: ((text: string) => void) | null = null;
  const adapter = teeRealtimeAdapter(baseAdapter, (ev) => {
    if (ev.type === "transcript" && ev.role === "assistant" && ev.final && onAssistantTranscript) {
      onAssistantTranscript(ev.text);
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

  return {
    session,
    label: "native-realtime",
    get onAssistantTranscript() {
      return onAssistantTranscript;
    },
    set onAssistantTranscript(v) {
      onAssistantTranscript = v;
    },
  };
}

// ---------------------------------------------------------------------------
// Live TTS — direct POST to OpenAI /v1/audio/speech, stream PCM, resample 24k→16k
// ---------------------------------------------------------------------------

const EXAMINER_TTS_SOURCE_RATE = 24000;

async function synthesizeExaminerUtterance(text: string, model: string): Promise<Int16Array> {
  const apiKey = process.env["OPENAI_API_KEY"]?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY required for examiner TTS");
  const baseUrl = stripTrailingSlash(
    process.env["OPENAI_BASE_URL"]?.trim() || "https://api.openai.com/v1",
  );

  const response = await fetch(`${baseUrl}/audio/speech`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: text,
      response_format: "pcm",
      stream: true,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`examiner TTS HTTP ${String(response.status)}: ${body.slice(0, 200)}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("examiner TTS: null response body");

  const resampler = new StreamingPcm16Resampler(EXAMINER_TTS_SOURCE_RATE, INPUT_SAMPLE_RATE_HZ);
  const chunks: Int16Array[] = [];
  const EMPTY = new Uint8Array(0);
  let carry: Uint8Array = EMPTY;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;

    const frame = value instanceof Uint8Array ? value : new Uint8Array(value);
    const buf = carry.byteLength === 0 ? frame : concatU8(carry, frame);
    const evenLen = buf.byteLength - (buf.byteLength % 2);

    if (evenLen > 0) {
      const pcmBytes = buf.subarray(0, evenLen);
      const samples = bytesToInt16LE(pcmBytes);
      const resampled = resampler.process(samples);
      if (resampled.length > 0) chunks.push(resampled);
    }
    carry = evenLen < buf.byteLength ? buf.subarray(evenLen) : EMPTY;
  }

  if (chunks.length === 0) {
    throw new Error("examiner TTS produced zero audio samples");
  }

  return concatInt16(...chunks);
}

// ---------------------------------------------------------------------------
// Live LLM examiner — picks next utterance + judges sub-goal completion
// ---------------------------------------------------------------------------

const EXAMINER_SCHEMA = z.object({
  utterance: z.string().describe("The next natural user utterance to speak."),
  subGoalComplete: z.boolean().describe("True if the agent's last response satisfies the current sub-goal."),
});

async function examinerGenerateNext(params: {
  model: ReturnType<ReturnType<typeof createOpenAI>>;
  task: DailyTask;
  currentSubGoalIndex: number;
  transcript: string;
  lastAgentReply: string;
}): Promise<{ utterance: string; subGoalComplete: boolean }> {
  const subGoal = params.task.subGoals[params.currentSubGoalIndex];
  if (!subGoal) throw new Error(`sub-goal index ${params.currentSubGoalIndex} out of range`);

  const remainingGoals = params.task.subGoals
    .slice(params.currentSubGoalIndex)
    .map((g, i) => `${i === 0 ? "→ " : "  "}${g.description}`)
    .join("\n");

  const system = [
    `You are a student making a phone call to Syrinx University Student Relations.`,
    `Your scenario: ${params.task.scenario}`,
    ``,
    `Current sub-goal: ${subGoal.description}`,
    `Remaining sub-goals:`,
    remainingGoals,
    ``,
    `You are having ONE continuous phone conversation. Speak naturally like a real student — use conversational language, not a script. Keep each utterance to 1-2 sentences.`,
    ``,
    `Rules:`,
    `- If the agent's response satisfies the current sub-goal, set subGoalComplete=true and naturally move to the next sub-goal in your utterance.`,
    `- If the agent asks a question or needs clarification, answer it naturally — do NOT advance the sub-goal.`,
    `- If the agent's response is off-topic or confused, gently redirect back to your goal.`,
    `- Never say you're an AI or that this is a test.`,
  ].join("\n");

  const prompt = [
    `Conversation so far:`,
    params.transcript || "(start of call — no conversation yet)",
    ``,
    params.lastAgentReply
      ? `Agent just said: "${params.lastAgentReply}"`
      : "Agent has not responded yet.",
    ``,
    `Based on this, what do you say next? And has the current sub-goal been satisfied?`,
  ].join("\n");

  const result = await generateObject({
    model: params.model,
    schema: EXAMINER_SCHEMA,
    system,
    prompt,
    temperature: 0.2,
    maxOutputTokens: 200,
  });

  return {
    utterance: result.object.utterance.trim(),
    subGoalComplete: result.object.subGoalComplete,
  };
}

// ---------------------------------------------------------------------------
// Dry mode stubs
// ---------------------------------------------------------------------------

const DRY_TTS_PCM = makeDryTtsPcm("This is a stub examiner utterance.");
const DRY_AGENT_REPLIES = [
  "Welcome to Student Relations. How can I help you today?",
  "I can help you book an advising appointment. Your advisor is Dr. Priya Raman. The next available video appointment is tomorrow at 2:45 PM.",
  "Yes, the late add deadline for Biology 101 is February 5th, so we should schedule before then. Would you like me to confirm the 2:45 PM slot?",
  "Your appointment is confirmed for tomorrow at 2:45 PM with Dr. Raman. You should bring your transcript and any relevant course forms.",
  "No additional forms are needed — just your student ID. Is there anything else I can help with?",
  "You're all set. Have a great day!",
];
const DRY_EXAMINER_UTTERANCES = [
  "Hi, I'm Maya Chen, student ID S10042. I'd like to book an advising appointment with Dr. Raman.",
  "Yes, I need to meet before the late add deadline for Biology 101 — that's February 5th, right?",
  "2:45 PM tomorrow works great, please confirm that.",
  "Great, I'll bring my transcript. Are there any other forms I'll need?",
  "No, that's everything. Thank you so much!",
  "Goodbye!",
];

function makeDryTtsPcm(text: string): Int16Array {
  // Produce ~0.3s of 440Hz tone as a stand-in for real TTS audio.
  const durationSamples = Math.floor(INPUT_SAMPLE_RATE_HZ * 0.3);
  const out = new Int16Array(durationSamples);
  for (let i = 0; i < durationSamples; i++) {
    out[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / INPUT_SAMPLE_RATE_HZ) * 8000);
  }
  return out;
}

function drySynthesizeUtterance(_text: string): Promise<Int16Array> {
  return Promise.resolve(new Int16Array(DRY_TTS_PCM));
}

function resolveStubExaminerModel(): ReturnType<ReturnType<typeof createOpenAI>> {
  // In dry mode we never call it — satisfies type.
  return createOpenAI({ apiKey: "sk-stub" })("gpt-4o-mini");
}

class DrySessionBus {
  private listeners = new Map<string, Set<(...args: any[]) => void>>();
  private replyIndex = 0;

  push(_route: number, packet: { kind: string; contextId: string; audio?: Uint8Array }): void {
    if (packet.kind !== "user.audio_received") return;
    // After receiving user audio, auto-emit a canned agent response.
    // Delays are generous to simulate real agent think-time (~1-2s).
    const contextId = packet.contextId;
    const reply = this.nextReply();
    setTimeout(() => {
      // tts.audio — a short burst of "audio" at 16kHz
      const samples = new Int16Array(Math.floor(INPUT_SAMPLE_RATE_HZ * 0.5));
      for (let i = 0; i < samples.length; i++) {
        samples[i] = Math.round(Math.sin((2 * Math.PI * 300 * i) / INPUT_SAMPLE_RATE_HZ) * 6000);
      }
      this.emit("tts.audio", {
        kind: "tts.audio",
        contextId,
        timestampMs: Date.now(),
        audio: new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength),
        sampleRateHz: INPUT_SAMPLE_RATE_HZ,
        provider: { name: "stub", model: "stub", cancelled: false },
      } satisfies TextToSpeechAudioPacket);
    }, 1200);
    setTimeout(() => {
      this.emit("tts.end", {
        kind: "tts.end",
        contextId,
        timestampMs: Date.now(),
      } satisfies TextToSpeechEndPacket);
    }, 1500);
    // Also emit agent_text_delta on the session
    if (this.onSessionEvent) {
      setTimeout(() => {
        this.onSessionEvent?.("agent_text_delta", { tsMs: Date.now(), turnId: contextId, delta: reply });
      }, 1000);
    }
  }

  on(kind: string, handler: (...args: any[]) => void): () => void {
    if (!this.listeners.has(kind)) this.listeners.set(kind, new Set());
    this.listeners.get(kind)!.add(handler);
    return () => {
      this.listeners.get(kind)?.delete(handler);
    };
  }

  private nextReply(): string {
    const reply = DRY_AGENT_REPLIES[this.replyIndex % DRY_AGENT_REPLIES.length]!;
    this.replyIndex++;
    return reply;
  }

  private emit(kind: string, packet: unknown): void {
    const handlers = this.listeners.get(kind);
    if (!handlers) return;
    for (const handler of handlers) {
      try { handler(packet); } catch { /* ignore listener errors in dry mode */ }
    }
  }

  // Session-level event emitter — bridged for agent_text_delta
  onSessionEvent: ((event: string, data: unknown) => void) | null = null;
}

function dryExaminerGenerateNext(params: {
  task: DailyTask;
  currentSubGoalIndex: number;
  turnIndex: number;
}): { utterance: string; subGoalComplete: boolean } {
  const utterance = DRY_EXAMINER_UTTERANCES[params.turnIndex % DRY_EXAMINER_UTTERANCES.length]!;
  // Advance sub-goal every ~2 turns
  const subGoalComplete = params.turnIndex > 0 && params.turnIndex % 2 === 0;
  return { utterance, subGoalComplete };
}

function createDrySession(): CapturableSession {
  const bus = new DrySessionBus();
  const sessionListeners = new Map<string, Set<(...args: any[]) => void>>();

  const session: CapturableSession = {
    bus: {
      push: (route: number, packet: any) => bus.push(route, packet),
      on: (kind: string, handler: any) => bus.on(kind, handler),
    },
    on(event: string, handler: (...args: any[]) => void) {
      if (!sessionListeners.has(event)) sessionListeners.set(event, new Set());
      sessionListeners.get(event)!.add(handler);
      if (event === "agent_text_delta") {
        bus.onSessionEvent = (ev, data) => {
          if (ev === event) handler(data);
        };
      }
    },
    off(event: string, handler: (...args: any[]) => void) {
      sessionListeners.get(event)?.delete(handler);
    },
    start: async () => {},
    close: async () => {},
    registerPlugin: () => {},
  };
  return session;
}

function writeDrySyntheticConversationWav(outputDir: string): string {
  // Write a minimal stereo WAV with a few frames of "overlap" so measureStereoOverlapMs
  // exercises the real code path and returns a non-zero value.
  const sampleRate = INPUT_SAMPLE_RATE_HZ;
  const durationFrames = sampleRate; // 1 second
  const stereo = Buffer.alloc(durationFrames * 4);
  // Channel 0 (user): tone from frames 0..0.5s, silence after
  // Channel 1 (assistant): silence until 0.3s, tone from 0.3..0.8s
  // → overlap at 0.3-0.5s = ~200ms
  for (let i = 0; i < durationFrames; i++) {
    const t = i / sampleRate;
    const userActive = t < 0.5;
    const assistantActive = t >= 0.3 && t < 0.8;
    const userSample = userActive ? Math.round(Math.sin(2 * Math.PI * 440 * t) * 8000) : 0;
    const assistantSample = assistantActive ? Math.round(Math.sin(2 * Math.PI * 300 * t) * 6000) : 0;
    stereo.writeInt16LE(userSample, i * 4);
    stereo.writeInt16LE(assistantSample, i * 4 + 2);
  }
  const wav = pcm16StereoToWav(stereo, sampleRate);
  const path = join(outputDir, "conversation.wav");
  // Sync write for simplicity in dry mode (no real async I/O needed).
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(path, wav);
  return path;
}

function pcm16StereoToWav(pcm: Buffer, sampleRate: number): Buffer {
  const dataLen = pcm.byteLength;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataLen, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(2, 22); // stereo
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 4, 28); // byte rate
  header.writeUInt16LE(4, 32); // block align
  header.writeUInt16LE(16, 34); // bits
  header.write("data", 36);
  header.writeUInt32LE(dataLen, 40);
  return Buffer.concat([header, pcm]);
}

// ---------------------------------------------------------------------------
// Turn execution (live + dry modes share the loop structure)
// ---------------------------------------------------------------------------

interface TurnCapture {
  firstAudioAtMs: number;
  lastAudioAtMs: number;
  ttsEndedAtMs: number;
  agentReply: string;
  error: string;
  /** Ignore agent audio before this wall-clock ms (the examiner's utterance-end) so a
   *  prior turn's still-streaming reply cannot be mis-captured as this turn's first audio
   *  (which produced negative latencies for long native replies). 0 = no gate (dry mode). */
  captureAfterMs: number;
}

function captureAgentResponse(
  agent: AgentUnderTest,
  turnId: string,
): { capture: TurnCapture; dispose: () => void } {
  const capture: TurnCapture = {
    firstAudioAtMs: 0,
    lastAudioAtMs: 0,
    ttsEndedAtMs: 0,
    agentReply: "",
    error: "",
    captureAfterMs: 0,
  };

  // Capture UNFILTERED by contextId (dispose-scoped to one turn — the examiner runs turns
  // sequentially and disposes between them). Load-bearing for the native arm: the realtime
  // bridge tags tts.audio/tts.end with its OWN contextId (a fresh uuid per response), never
  // the examiner's turnId, so a turnId filter captures nothing for native (firstAudio stays 0
  // → timeout). Cascade tags with turnId via turn.change, but unfiltered works for it too.
  const offTtsAudio = agent.session.bus.on("tts.audio", (pkt: unknown) => {
    const a = pkt as { contextId?: string; timestampMs: number };
    capture.lastAudioAtMs = Date.now();
    if (capture.captureAfterMs > 0 && a.timestampMs < capture.captureAfterMs) return;
    if (capture.firstAudioAtMs === 0) capture.firstAudioAtMs = a.timestampMs;
  });

  const offTtsEnd = agent.session.bus.on("tts.end", (pkt: unknown) => {
    const e = pkt as { contextId?: string; timestampMs: number };
    capture.ttsEndedAtMs = e.timestampMs;
  });

  const onAgentDelta = (event: { tsMs: number; turnId: string; delta: string }) => {
    if (event.turnId !== turnId) return;
    capture.agentReply += event.delta;
  };

  const onAssistantTranscript = (text: string) => {
    capture.agentReply = capture.agentReply
      ? `${capture.agentReply} ${text}`.trim()
      : text.trim();
  };

  const onError = (event: { stage: string; category: string; message: string }) => {
    capture.error = `${event.stage}/${event.category}: ${event.message}`;
  };

  agent.session.on("agent_text_delta", onAgentDelta);
  agent.session.on("error", onError);
  if (agent.onAssistantTranscript !== undefined) {
    agent.onAssistantTranscript = onAssistantTranscript;
  }

  return {
    capture,
    dispose: () => {
      offTtsAudio();
      offTtsEnd();
      agent.session.off("agent_text_delta", onAgentDelta);
      agent.session.off("error", onError);
      if (agent.onAssistantTranscript === onAssistantTranscript) {
        agent.onAssistantTranscript = null;
      }
    },
  };
}

async function waitForAgentResponse(capture: TurnCapture, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (capture.error) throw new Error(capture.error);
    if (capture.firstAudioAtMs > 0 && capture.ttsEndedAtMs > 0) return;
    await sleep(100);
  }
  throw new Error(
    `agent response timeout after ${timeoutMs}ms (firstAudio=${capture.firstAudioAtMs}, ttsEnd=${capture.ttsEndedAtMs})`,
  );
}

async function sendPcmFrames(
  session: CapturableSession,
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
      audio: new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength),
    });
    await sleep(20);
  }
}

async function sendSilence(
  session: CapturableSession,
  contextId: string,
  durationMs: number,
): Promise<void> {
  const frames = Math.ceil(durationMs / 20);
  for (let i = 0; i < frames; i++) {
    const frame = new Int16Array(FRAME_SAMPLES);
    session.bus.push(Route.Main, {
      kind: "user.audio_received",
      contextId,
      timestampMs: Date.now(),
      audio: new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength),
    });
    await sleep(20);
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

export async function runFullduplexExaminer(options: FdeOptions): Promise<FdeResult> {
  const task = resolveDailyTask(options.taskName);
  const dry = options.dry;
  const apiKey = process.env["OPENAI_API_KEY"]?.trim() ?? "";

  // Create agent-under-test
  let agent: AgentUnderTest;
  if (dry) {
    const drySession = createDrySession();
    agent = { session: drySession, label: "stub" };
  } else if (options.agentKind === "native") {
    agent = nativeRealtimeAgent(apiKey);
  } else {
    agent = cascadeAgent({ ttsProvider: options.ttsProvider });
  }

  // Create LLM model (dry mode uses a stub key — never called)
  const examinerModel = createOpenAI({
    apiKey: apiKey || "sk-stub",
    baseURL: process.env["OPENAI_BASE_URL"]?.trim() || undefined,
  })(options.examinerModel);

  // Register the recorder BEFORE start() — plugins are initialized during start(), so a
  // recorder registered afterwards never records (it wrote nothing → empty dir → the overlap
  // step failed on a missing conversation.wav).
  if (!dry) {
    await mkdir(options.recorderDir, { recursive: true });
    agent.session.registerPlugin(
      "recorder",
      createVoiceSessionRecorder({
        outputDir: options.recorderDir,
        sessionId: "fd-examiner",
        userSampleRateHz: INPUT_SAMPLE_RATE_HZ,
        assistantSampleRateHz: options.ttsProvider === "cartesia" ? 16000 : 24000,
      }),
    );
  }
  await agent.session.start();

  const turns: FdeTurnMetrics[] = [];
  let transcript = "";
  let currentSubGoalIndex = 0;
  let lastAgentReply = "";
  let turnIndex = 0;

  try {
    while (turnIndex < options.maxTurns) {
      // --- Examiner decides next utterance ---
      let utterance: string;
      let subGoalComplete: boolean;

      if (dry) {
        const result = dryExaminerGenerateNext({ task, currentSubGoalIndex, turnIndex });
        utterance = result.utterance;
        subGoalComplete = result.subGoalComplete;
      } else {
        const result = await examinerGenerateNext({
          model: examinerModel,
          task,
          currentSubGoalIndex,
          transcript,
          lastAgentReply,
        });
        utterance = result.utterance;
        subGoalComplete = result.subGoalComplete;
      }

      // --- Synthesize utterance ---
      let samples: Int16Array;
      if (dry) {
        samples = await drySynthesizeUtterance(utterance);
      } else {
        samples = await synthesizeExaminerUtterance(utterance, options.examinerTtsModel);
      }

      // --- Send utterance + trailing silence ---
      // Install listeners BEFORE sending frames so dry-mode stub events
      // that fire during transmission are captured.
      const turnId = `examiner-turn-${String(turnIndex + 1).padStart(2, "0")}`;
      const { capture, dispose } = captureAgentResponse(agent, turnId);
      // Signal turn boundary so the cascade agent scopes TTS events to this turn.
      // Native realtime owns turn detection via server_vad and must NOT receive turn.change.
      if (agent.label !== "native-realtime") {
        agent.session.bus.push(Route.Main, {
          kind: "turn.change",
          contextId: turnId,
          previousContextId: "",
          reason: "fd_examiner",
          timestampMs: Date.now(),
        });
      }
      await sendPcmFrames(agent.session, samples, turnId);
      const utteranceEndAtMs = Date.now();
      // Only count agent audio that starts AFTER the examiner stops speaking (dry mode keeps
      // the stub's deterministic timing → no gate).
      if (!dry) capture.captureAfterMs = utteranceEndAtMs;
      await sendSilence(agent.session, turnId, POST_UTTERANCE_SILENCE_MS);

      // --- Wait for agent response ---
      let responseLatencyMs = 0;
      let responseEndAtMs = utteranceEndAtMs;
      try {
        await waitForAgentResponse(capture, options.responseTimeoutMs);
        responseLatencyMs = capture.firstAudioAtMs - utteranceEndAtMs;
        responseEndAtMs = capture.ttsEndedAtMs;
      } catch (err) {
        dispose();
        throw err;
      }
      // Drain the agent's response fully before the next turn. Long native replies keep
      // streaming after the first ttsEnd; starting the next utterance now lets this turn's
      // tail bleed into the next capture (a straggler before utteranceEnd → negative latency).
      // This is also correct turn-taking: wait for the agent to finish before speaking.
      const drainDeadline = Date.now() + RESPONSE_DRAIN_CAP_MS;
      while (
        !dry &&
        capture.lastAudioAtMs > 0 &&
        Date.now() < drainDeadline &&
        Date.now() - capture.lastAudioAtMs < RESPONSE_QUIET_MS
      ) {
        await sleep(150);
      }
      dispose();

      lastAgentReply = capture.agentReply.trim();

      // --- Update transcript ---
      transcript += `\nStudent: "${utterance}"\nAgent: "${lastAgentReply || "(no text captured)"}"`;

      // --- Record metrics ---
      turns.push({
        turn: turnIndex + 1,
        utteranceText: utterance,
        utteranceEndAtMs,
        firstResponseAudioAtMs: capture.firstAudioAtMs,
        responseEndAtMs,
        responseLatencyMs,
        agentReply: lastAgentReply,
      });

      // --- Advance sub-goal ---
      if (subGoalComplete && currentSubGoalIndex < task.subGoals.length - 1) {
        currentSubGoalIndex++;
      }

      // --- Check termination ---
      if (currentSubGoalIndex >= task.subGoals.length - 1 && subGoalComplete) {
        // All sub-goals completed
        break;
      }

      turnIndex++;
    }
  } finally {
    await agent.session.close();
  }

  // --- Compute overlap ---
  let conversationOverlapMs = 0;
  if (dry) {
    const dryDir = join(options.outputDir, "dry");
    const wavPath = writeDrySyntheticConversationWav(dryDir);
    conversationOverlapMs = measureStereoOverlapMs(wavPath);
  } else {
    const conversationWav = join(options.recorderDir, "fd-examiner", "conversation.wav");
    conversationOverlapMs = measureStereoOverlapMs(conversationWav);
  }

  const latencies = turns.map((t) => t.responseLatencyMs);
  const medianLatency = median(latencies);
  const maxTurnsReached = turnIndex >= options.maxTurns;
  const subGoalsCompleted = currentSubGoalIndex >= task.subGoals.length - 1;

  return {
    task: task.name,
    taskName: task.name,
    dry,
    turns,
    responseLatenciesMs: latencies,
    medianResponseLatencyMs: medianLatency,
    conversationOverlapMs,
    totalTurns: turns.length,
    subGoalsCompleted,
    maxTurnsReached,
  };
}

// ---------------------------------------------------------------------------
// Table + result output
// ---------------------------------------------------------------------------

function renderResultTable(result: FdeResult): string {
  const header = "| Turn | Utterance | Resp Latency (ms) | Agent Reply |";
  const sep = "|---|---|---|---|";
  const body = result.turns.map((t) => {
    const utterance = t.utteranceText.length > 60 ? t.utteranceText.slice(0, 57) + "..." : t.utteranceText;
    const reply = t.agentReply.length > 50 ? t.agentReply.slice(0, 47) + "..." : t.agentReply;
    return `| ${t.turn} | ${utterance} | ${t.responseLatencyMs} | ${reply} |`;
  });
  return [header, sep, ...body].join("\n");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function isDryMode(argv: readonly string[] = process.argv): boolean {
  if (process.env["SYRINX_FDE_DRY"] === "1") return true;
  return argv.includes("--dry");
}

function ensureLiveEnv(agentKind: "cascade" | "native"): void {
  const missing: string[] = [];
  if (!process.env["OPENAI_API_KEY"]?.trim()) missing.push("OPENAI_API_KEY");
  if (agentKind === "cascade") {
    if (!process.env["DEEPGRAM_API_KEY"]?.trim()) missing.push("DEEPGRAM_API_KEY");
    if (
      !process.env["CARTESIA_API_KEY"]?.trim() &&
      !process.env["GOOGLE_GENERATIVE_AI_API_KEY"]?.trim()
    ) {
      missing.push("CARTESIA_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY");
    }
  }
  if (missing.length > 0) throw new Error(`missing live provider env: ${missing.join(", ")}`);
}

function chooseTtsProvider(): UniversitySupportTtsProvider {
  const requested = process.env["SYRINX_REVIEW_TTS"]?.trim().toLowerCase();
  if (requested === "gemini" || requested === "cartesia" || requested === "deepgram") return requested;
  return process.env["CARTESIA_API_KEY"]?.trim() ? "cartesia" : "gemini";
}

export function resolveExaminerModel(): string {
  return process.env["SYRINX_EXAMINER_MODEL"]?.trim() || "gpt-4o-mini";
}

export function resolveExaminerTtsModel(): string {
  return process.env["SYRINX_EXAMINER_TTS_MODEL"]?.trim() || "gpt-4o-mini-tts";
}

async function main(): Promise<void> {
  const dry = isDryMode();
  const agentKind = process.env["SYRINX_FDE_AGENT"] === "native" ? "native" : "cascade";
  if (!dry) {
    ensureRepoRootDotenv();
    ensureLiveEnv(agentKind);
  }

  const outputDir = join(PKG_ROOT, "..", "..", "runs");
  const recorderDir = join(outputDir, "fd-examiner-recorder");
  await mkdir(outputDir, { recursive: true });

  const taskName = process.env["SYRINX_FDE_TASK"]?.trim() || "book-advising-appointment";
  const maxTurns = parseInt(process.env["SYRINX_FDE_MAX_TURNS"] ?? "", 10) || DEFAULT_MAX_TURNS;
  const responseTimeoutMs = parseInt(process.env["SYRINX_FDE_TIMEOUT_MS"] ?? "", 10) || DEFAULT_RESPONSE_TIMEOUT_MS;

  const result = await runFullduplexExaminer({
    dry,
    agentKind,
    taskName,
    maxTurns,
    responseTimeoutMs,
    outputDir,
    recorderDir,
    ttsProvider: dry ? "cartesia" : chooseTtsProvider(),
    examinerModel: resolveExaminerModel(),
    examinerTtsModel: resolveExaminerTtsModel(),
  });

  // eslint-disable-next-line no-console
  console.log("# Full-Duplex Examiner (increment 1)\n");
  // eslint-disable-next-line no-console
  console.log(`Task: ${result.task} | Turns: ${result.totalTurns} | Goals done: ${result.subGoalsCompleted} | Max reached: ${result.maxTurnsReached}`);
  // eslint-disable-next-line no-console
  console.log(`Response latencies (ms): ${result.responseLatenciesMs.join(", ")} | Median: ${result.medianResponseLatencyMs}`);
  // eslint-disable-next-line no-console
  console.log(`Conversation overlap: ${result.conversationOverlapMs}ms\n`);
  // eslint-disable-next-line no-console
  console.log(renderResultTable(result));

  const jsonResult = `${JSON.stringify(result, null, 2)}\n`;
  const resultPath = join(outputDir, "fd-examiner-result.json");
  await writeFile(resultPath, jsonResult, "utf8");
  // eslint-disable-next-line no-console
  console.log(`\nResult written to ${resultPath}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function concatU8(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

function bytesToInt16LE(bytes: Uint8Array): Int16Array {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return new Int16Array(ab);
}

function concatInt16(...arrays: Int16Array[]): Int16Array {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Int16Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
