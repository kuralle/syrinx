// SPDX-License-Identifier: MIT
//
// FALSIFICATION SPIKE (Phase 0, assumptions A2 + A3) — LIVE.
//
// A2 under test: "LLM + tool round-trips dominate the ~5.3s cascade turn (2.6-4.3s)."
//   Source of the claim: a single n=3 /diagnose replay recorded in
//   docs/interaction-thesis-results.md — an anecdote, never a metric.
// A3 under test: "tools explain the gap between latency-budget.md's ~0.9s and the
//   examiner's 5.3s."
//
// Method: run ONE real cascade turn (Deepgram STT -> gpt-4.1-mini + tools -> Cartesia
// TTS) against the same university fixture the thesis matrix used, subscribing to the
// bus events that ALREADY exist, and attribute every millisecond of the turn to a
// named stage. Whatever the four stages do not explain is reported as an explicit
// unattributed residual rather than hidden.
//
// Run: npx tsx scripts/spike-turn-decomposition-live.ts

import { writeFile } from "node:fs/promises";

import { createOpenAI } from "@ai-sdk/openai";
import { tool, stepCountIs } from "ai";
import { z } from "zod";

import { Route, VoiceAgentSession } from "@kuralle-syrinx/core";
import { fromStreamText } from "@kuralle-syrinx/aisdk";
import { RealtimeBridge, fromOpenAIRealtime } from "@kuralle-syrinx/realtime";
import { createNodeWsSocket } from "@kuralle-syrinx/ws/node";
import type {
  LlmToolCallPacket,
  LlmToolResultPacket,
  TextToSpeechAudioPacket,
  TextToSpeechEndPacket,
} from "@kuralle-syrinx/core";

import {
  GEMINI_UNIVERSITY_FIXTURES,
  ensureGeminiUniversityFixtures,
} from "./generate-gemini-university-fixtures.js";
import { DEFAULT_MODEL, ensureRepoRootDotenv, readPcm16Mono16kWav } from "../src/run-one-turn.js";
import {
  createUniversitySupportSession,
  studentRelationsTools,
} from "../src/university-support-agent.js";

/** Which front to measure. Both drive the SAME fixture through the SAME tools. */
const ARM = (process.env["SYRINX_SPIKE_ARM"]?.trim() || "cascade") as "cascade" | "native";

/**
 * Prompt variant for the preamble A/B.
 *
 * `strict` is the shipped prompt. Its "Call studentRelationsLookup before answering"
 * line is the suspected suppressor of pre-tool preamble text — and our measured
 * llmTtftMs of 3412ms (time to the FIRST llm.delta) is evidence that no preamble was
 * emitted, since a preamble would land at pass-1 TTFT (~500-800ms) instead.
 *
 * `preamble` keeps the same grounding contract but explicitly asks for one short spoken
 * line BEFORE the tool call. If the claim holds, firstLlmDelta drops by seconds while
 * the grounded answer arrives at roughly the same time.
 */
const PROMPT_MODE = (process.env["SYRINX_SPIKE_PROMPT"]?.trim() || "strict") as
  | "strict"
  | "preamble";

const PREAMBLE_PROMPT = [
  "You are Syrinx University's Student Relations voice agent.",
  "This is one ongoing phone conversation. Use the previous turns for references like it, that, the case, or the petition.",
  "Before calling a tool, first say ONE short spoken sentence telling the student what you are about to check (for example: \"Let me pull up your registration record.\"). Then call the tool.",
  "Use studentRelationsLookup whenever the answer depends on student records, deadlines, holds, offices, fees, appointments, or case status.",
  "Never invent deadlines, approvals, holds, fees, visa guidance, accommodations, appointments, or case status.",
  "After the tool result, answer in two concise complete sentences. Confirm the action first, then mention the constraint or next owner.",
  "Never end with an incomplete sentence or phrase. Every answer must end with punctuation.",
].join("\n");

const FRAME_SAMPLES = 320; // 20ms @ 16kHz
const TRAILING_SILENCE_MS = 2000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface ToolSpan {
  readonly name: string;
  readonly startMs: number;
  endMs: number;
}

interface Marks {
  speechStartMs: number;
  speechEndMs: number; // last real-speech frame pushed
  sttFinalMs: number;
  eosMs: number;
  firstLlmDeltaMs: number;
  firstTtsTextMs: number;
  firstTtsAudioMs: number;
  ttsEndMs: number;
  readonly tools: ToolSpan[];
}

function newMarks(): Marks {
  return {
    speechStartMs: 0,
    speechEndMs: 0,
    sttFinalMs: 0,
    eosMs: 0,
    firstLlmDeltaMs: 0,
    firstTtsTextMs: 0,
    firstTtsAudioMs: 0,
    ttsEndMs: 0,
    tools: [],
  };
}

/** Payload of the ALREADY-SHIPPED `turn_latency` session event. */
interface TurnLatencyEvent {
  readonly ttfaMs: number;
  readonly anchor: "speech_end" | "eos";
  readonly eouDelayMs?: number;
  readonly llmTtftMs?: number;
  readonly textAggregationMs?: number;
  readonly ttsTtfbMs?: number;
  readonly unattributedMs: number;
  readonly llmCallCount?: number;
  readonly llmPassTtftMs?: readonly number[];
  readonly fillerUsed: boolean;
}

function wire(
  session: VoiceAgentSession,
  m: Marks,
  sink: TurnLatencyEvent[],
  spoken: { text: string; firstAtMs: number },
): () => void {
  const onTurnLatency = (e: TurnLatencyEvent): void => {
    sink.push(e);
  };
  session.on("turn_latency", onTurnLatency);

  // SYRINX_SPIKE_TRACE=1 prints the ordered (kind, contextId) sequence. Guessing at why
  // turn_latency does not fire has already cost one wrong fix; this shows the actual identities.
  const traceOffs: Array<() => void> = [];
  if (process.env["SYRINX_SPIKE_TRACE"] === "1") {
    const t0 = Date.now();
    for (const kind of [
      "vad.speech_started",
      "vad.speech_ended",
      "turn.change",
      "eos.turn_complete",
      "llm.delta",
      "tts.text",
      "tts.audio",
      "tts.end",
      "interrupt.detected",
    ]) {
      let seen = 0;
      traceOffs.push(
        session.bus.on(kind, (pkt) => {
          const p = pkt as { contextId?: string; previousContextId?: string };
          // tts.audio/llm.delta fire many times; only the first of each matters here.
          seen += 1;
          if (seen > 1 && (kind === "tts.audio" || kind === "llm.delta" || kind === "tts.text")) return;
          console.log(
            `[trace +${String(Date.now() - t0).padStart(6)}ms] ${kind.padEnd(20)} ctx=${p.contextId ?? "-"}` +
              (p.previousContextId ? ` prev=${p.previousContextId}` : ""),
          );
        }),
      );
    }
  }
  // Capture what was actually SAID, in order — the direct evidence of whether a
  // pre-tool preamble was emitted, rather than inferring it from timing alone.
  const onDelta = (e: { tsMs: number; delta: string }): void => {
    if (spoken.firstAtMs === 0) spoken.firstAtMs = e.tsMs;
    spoken.text += e.delta;
  };
  session.on("agent_text_delta", onDelta);
  const pending = new Map<string, ToolSpan>();
  const offs = [
    session.bus.on("stt.result", (pkt) => {
      if (m.sttFinalMs === 0) m.sttFinalMs = (pkt as { timestampMs: number }).timestampMs;
    }),
    session.bus.on("eos.turn_complete", (pkt) => {
      if (m.eosMs === 0) m.eosMs = (pkt as { timestampMs: number }).timestampMs;
    }),
    session.bus.on("llm.delta", (pkt) => {
      if (m.firstLlmDeltaMs === 0) m.firstLlmDeltaMs = (pkt as { timestampMs: number }).timestampMs;
    }),
    session.bus.on<LlmToolCallPacket>("llm.tool_call", (pkt) => {
      const span: ToolSpan = { name: pkt.toolName, startMs: pkt.timestampMs, endMs: 0 };
      pending.set(pkt.toolId, span);
      m.tools.push(span);
    }),
    session.bus.on<LlmToolResultPacket>("llm.tool_result", (pkt) => {
      const span = pending.get(pkt.toolId);
      if (span) span.endMs = pkt.timestampMs;
    }),
    session.bus.on("tts.text", (pkt) => {
      if (m.firstTtsTextMs === 0) m.firstTtsTextMs = (pkt as { timestampMs: number }).timestampMs;
    }),
    session.bus.on<TextToSpeechAudioPacket>("tts.audio", (pkt) => {
      if (m.firstTtsAudioMs === 0) m.firstTtsAudioMs = pkt.timestampMs;
    }),
    session.bus.on<TextToSpeechEndPacket>("tts.end", (pkt) => {
      m.ttsEndMs = pkt.timestampMs;
    }),
  ];
  return () => {
    for (const off of offs) off();
    session.off("turn_latency", onTurnLatency);
    session.off("agent_text_delta", onDelta);
    for (const off of traceOffs) off();
  };
}

/**
 * Push 20ms frames in REAL TIME. Naive `await sleep(20)` per frame accumulates
 * scheduler + bus-drain overhead (measured: a 3.2s fixture took 22s, which let the
 * endpointer fire mid-push and produced negative latencies). Pacing against an
 * absolute schedule self-corrects that drift.
 */
async function pushFrames(
  session: VoiceAgentSession,
  contextId: string,
  samples: Int16Array | null,
  frames: number,
  startedAtMs: number,
  frameOffset: number,
  stopWhenEos: () => boolean = () => false,
): Promise<number> {
  const total = samples ? Math.ceil(samples.length / FRAME_SAMPLES) : frames;
  for (let i = 0; i < total; i += 1) {
    // Once the endpointer has fired, the user has "stopped talking". Continuing to
    // push frames makes this loop contend with the LLM stream for the event loop and
    // inflates the very number we are trying to measure.
    if (stopWhenEos()) return frameOffset + i;
    const frameIndex = frameOffset + i;
    const dueAtMs = startedAtMs + frameIndex * 20;
    const waitMs = dueAtMs - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    const frame = new Int16Array(FRAME_SAMPLES);
    if (samples) frame.set(samples.subarray(i * FRAME_SAMPLES, (i + 1) * FRAME_SAMPLES));
    session.bus.push(Route.Main, {
      kind: "user.audio_received",
      contextId,
      timestampMs: Date.now(),
      audio: new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength),
      sampleRateHz: 16_000,
    });
  }
  return frameOffset + total;
}

/**
 * Native realtime front + delegated reasoner, mirroring the thesis matrix's native arm
 * (same tools, same prompt shape) so the two arms differ ONLY in the front.
 */
function createNativeSession(apiKey: string): { session: VoiceAgentSession; close: () => Promise<void> } {
  const adapter = fromOpenAIRealtime({
    apiKey,
    socketFactory: createNodeWsSocket,
    turnDetection: { type: "server_vad", silence_duration_ms: 500 },
    tools: [
      {
        name: "ask_university",
        description: "Answer university student-relations questions (enrollment, add/drop, advising).",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ],
  });

  const reasoner = fromStreamText({
    model: createOpenAI({ apiKey })(process.env["SYRINX_LLM_MODEL"]?.trim() || DEFAULT_MODEL),
    system: [
      "You are Syrinx University's Student Relations voice agent.",
      "Call studentRelationsLookup before answering student-services requests.",
      "Never invent deadlines, approvals, holds, fees, or appointments.",
      "For voice, answer in two concise complete sentences.",
    ].join("\n"),
    tools: studentRelationsTools,
    temperature: 0.2,
    maxOutputTokens: 180,
    maxRetries: 0,
    timeout: 45_000,
    stopWhen: stepCountIs(4),
  });

  const bridge = new RealtimeBridge(adapter, reasoner, "ask_university");
  const session = new VoiceAgentSession({
    plugins: { realtime: {} },
    endpointingOwner: "timer",
  });
  session.registerPlugin("realtime", bridge);
  return { session, close: async () => { await adapter.close(); } };
}

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  await ensureGeminiUniversityFixtures();

  const fixture = GEMINI_UNIVERSITY_FIXTURES[0];
  if (!fixture) throw new Error("no university fixture available");

  const samples = readPcm16Mono16kWav(fixture.path);
  const apiKey = process.env["OPENAI_API_KEY"];
  if (ARM === "native" && !apiKey) throw new Error("OPENAI_API_KEY required for the native arm");

  const native = ARM === "native" ? createNativeSession(apiKey as string) : null;
  const session =
    native?.session ??
    createUniversitySupportSession({
      inputSampleRate: 16_000,
      profile: "interactive",
      ...(PROMPT_MODE === "preamble" ? { systemPrompt: PREAMBLE_PROMPT } : {}),
    });

  const m = newMarks();
  const shipped: TurnLatencyEvent[] = [];
  const spoken = { text: "", firstAtMs: 0 };
  const unwire = wire(session, m, shipped, spoken);
  const contextId = "spike-decomp-1";

  await session.start();
  try {
    const eosFired = (): boolean => m.eosMs > 0;
    m.speechStartMs = Date.now();
    const spoken = await pushFrames(
      session,
      contextId,
      samples,
      0,
      m.speechStartMs,
      0,
      eosFired,
    );
    m.speechEndMs = Date.now();
    await pushFrames(
      session,
      contextId,
      null,
      Math.ceil(TRAILING_SILENCE_MS / 20),
      m.speechStartMs,
      spoken,
      eosFired,
    );

    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (m.firstTtsAudioMs > 0 && m.ttsEndMs > 0) break;
      await sleep(100);
    }
    if (m.firstTtsAudioMs === 0) throw new Error("no assistant audio within 120s");
  } finally {
    unwire();
    // Teardown must never mask the real failure from the try block.
    try {
      await session.close();
      await native?.close();
    } catch (err) {
      console.error("teardown failed (non-fatal):", err);
    }
  }

  // --- attribution ---------------------------------------------------------
  const v2v = m.firstTtsAudioMs - m.speechEndMs;
  const endpoint = m.eosMs - m.speechEndMs;
  const toolTotal = m.tools.reduce(
    (sum, t) => sum + (t.endMs > 0 ? t.endMs - t.startMs : 0),
    0,
  );
  // LLM TTFT = eos -> first delta, minus any tool time that happened inside it
  // (with tool-calling, the first user-visible delta can land after the tools).
  const eosToFirstDelta = m.firstLlmDeltaMs > 0 ? m.firstLlmDeltaMs - m.eosMs : 0;
  const llmOnly = Math.max(0, eosToFirstDelta - toolTotal);
  const ttsTtfb =
    m.firstTtsTextMs > 0 ? m.firstTtsAudioMs - m.firstTtsTextMs : 0;
  const attributed = endpoint + llmOnly + toolTotal + ttsTtfb;
  const residual = v2v - attributed;
  const pct = (n: number): string => `${((n / v2v) * 100).toFixed(1)}%`;

  const lines = [
    `=== LIVE ${ARM} turn decomposition (n=1) ===`,
    `fixture: ${fixture.id} | prompt: ${PROMPT_MODE} | tools: ${String(m.tools.length)}`,
    "",
    "agent said (first 240 chars — look for a pre-tool preamble):",
    `  ${spoken.text.slice(0, 240).replace(/\n/g, " ") || "(nothing)"}`,
    `speech duration: ${m.speechEndMs - m.speechStartMs}ms`,
    "",
    `v2v (last speech frame -> first assistant audio): ${v2v}ms`,
    "",
    "stage attribution:",
    `  endpoint   (speechEnd -> eos.turn_complete)  ${String(endpoint).padStart(6)}ms  ${pct(endpoint)}`,
    `  llm        (eos -> first delta, minus tools) ${String(llmOnly).padStart(6)}ms  ${pct(llmOnly)}`,
    `  tools      (${m.tools.length} call(s), sum of round-trips) ${String(toolTotal).padStart(6)}ms  ${pct(toolTotal)}`,
    `  tts_ttfb   (tts.text -> first tts.audio)     ${String(ttsTtfb).padStart(6)}ms  ${pct(ttsTtfb)}`,
    `  ${"-".repeat(58)}`,
    `  attributed                                   ${String(attributed).padStart(6)}ms  ${pct(attributed)}`,
    `  UNATTRIBUTED residual                        ${String(residual).padStart(6)}ms  ${pct(residual)}`,
    "",
    "per-tool:",
    ...(m.tools.length
      ? m.tools.map(
          (t) =>
            `  ${t.name.padEnd(28)} ${t.endMs > 0 ? `${t.endMs - t.startMs}ms` : "NO RESULT PACKET"}`,
        )
      : ["  (no tool calls in this turn)"]),
    "",
    "=== what the ALREADY-SHIPPED `turn_latency` event reported ===",
    ...(shipped.length
      ? shipped.flatMap((e) => [
          `  ttfaMs            ${e.ttfaMs}ms   anchor=${e.anchor}  (fillerUsed=${String(e.fillerUsed)})`,
          `  eouDelayMs        ${e.eouDelayMs ?? "n/a"}ms`,
          `  llmTtftMs         ${e.llmTtftMs ?? "n/a"}ms`,
          `  textAggregationMs ${e.textAggregationMs ?? "n/a"}ms`,
          `  ttsTtfbMs         ${e.ttsTtfbMs ?? "n/a"}ms`,
          `  unattributedMs    ${e.unattributedMs}ms`,
          `  llmCallCount      ${e.llmCallCount ?? "n/a"}  passTtft=[${(e.llmPassTtftMs ?? []).join(", ")}]`,
        ])
      : ["  (turn_latency never fired)"]),
    "",
    "raw marks (ms since speechEnd):",
    `  sttFinal      ${m.sttFinalMs > 0 ? m.sttFinalMs - m.speechEndMs : "n/a"}`,
    `  eos           ${m.eosMs > 0 ? m.eosMs - m.speechEndMs : "n/a"}`,
    `  firstLlmDelta ${m.firstLlmDeltaMs > 0 ? m.firstLlmDeltaMs - m.speechEndMs : "n/a"}`,
    `  firstTtsText  ${m.firstTtsTextMs > 0 ? m.firstTtsTextMs - m.speechEndMs : "n/a"}`,
    `  firstTtsAudio ${m.firstTtsAudioMs - m.speechEndMs}`,
    `  ttsEnd        ${m.ttsEndMs > 0 ? m.ttsEndMs - m.speechEndMs : "n/a"}`,
  ];

  const out = lines.join("\n");
  console.log(out);
  await writeFile(
    new URL("../../../runs/spike-turn-decomposition.txt", import.meta.url),
    `${out}\n`,
    "utf8",
  );
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
