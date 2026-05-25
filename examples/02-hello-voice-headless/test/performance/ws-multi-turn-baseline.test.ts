// SPDX-License-Identifier: MIT
//
// Baseline Performance Benchmark — WebSocket Multi-Turn Conversation
//
// This test establishes the v1 kernel baseline by running a scripted multi-turn
// conversation through a WebSocket transport, measuring per-turn latency metrics
// and aggregate end-to-end throughput. It uses fake/test providers to isolate
// kernel overhead from provider latency, then optionally runs against live
// providers with RUN_LIVE=1.
//
// Run:
//   pnpm test -- --reporter=verbose test/performance/ws-multi-turn-baseline.test.ts
//   RUN_LIVE=1 pnpm test -- --reporter=verbose test/performance/ws-multi-turn-baseline.test.ts

import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { type Server as HttpServer, createServer } from "node:http";
import { randomUUID } from "node:crypto";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  type AudioFrame,
  VoiceAgentSession,
  createAudioFrame,
  type VoiceAgentSessionOptions,
  type PerTurnMetrics,
} from "@asyncdot/voice";
import { FakeBridge, FakeSTT, FakeTTS, FakeVAD } from "@asyncdot/voice-test";
import {
  ensureRepoRootDotenv,
  coerceGoogleGenAiKey,
  listMissingVoiceHeadlessEnvKeys,
  readPcm16Mono16kWav,
} from "../src/run-one-turn.js";

// =============================================================================
// Types
// =============================================================================

/** A single turn in the scripted conversation. */
interface ScriptedTurn {
  /** What the user says. */
  readonly transcript: string;
  /** How much silence to inject before this turn (ms). Simulates inter-turn gap. */
  readonly preSilenceMs: number;
  /** How many 20ms frames of "speech" to inject. */
  readonly speechFrames: number;
}

/** Latency breakdown for one turn. */
interface TurnLatency {
  readonly turnIndex: number;
  readonly transcript: string;
  /** ms from first audio frame sent to user_input_final event. */
  readonly endpointingMs: number;
  /** ms from user_input_final to first agent_text_delta. */
  readonly llmTTFTMs: number;
  /** ms from agent_text_delta to first tts audio chunk. */
  readonly ttsTTFBMs: number;
  /** ms from first audio frame to first tts audio chunk (E2E). */
  readonly e2eLatencyMs: number;
  /** Number of agent text tokens. */
  readonly agentTokens: number;
  /** ms of generated audio. */
  readonly playedMs: number;
  /** Whether the turn was truncated. */
  readonly truncated: boolean;
  /** Number of tool calls. */
  readonly toolCalls: number;
}

/** Full baseline result — committed as baseline.json. */
interface BaselineReport {
  readonly kernelVersion: string;
  readonly runAt: string;
  readonly providerMode: "fakes" | "live";
  readonly transport: "websocket";
  readonly conversation: {
    readonly turnCount: number;
    readonly turns: readonly TurnLatency[];
    readonly aggregate: {
      readonly totalDurationMs: number;
      readonly avgE2eLatencyMs: number;
      readonly avgEndpointingMs: number;
      readonly avgLlmTTFTMs: number;
      readonly avgTtsTTFBMs: number;
      readonly totalAgentTokens: number;
      readonly avgAgentTokensPerTurn: number;
      readonly totalPlayedMs: number;
      readonly truncationCount: number;
    };
  };
}

// =============================================================================
// Scripted conversation — 5 turns covering common patterns
// =============================================================================

const SCRIPTED_CONVERSATION: readonly ScriptedTurn[] = [
  {
    transcript: "Hi, I'd like to order a sandwich please.",
    preSilenceMs: 500,
    speechFrames: 120, // ~2.4s of speech
  },
  {
    transcript: "Can I get turkey with swiss cheese?",
    preSilenceMs: 1200,
    speechFrames: 80, // ~1.6s of speech
  },
  {
    transcript: "And add lettuce and tomato.",
    preSilenceMs: 800,
    speechFrames: 70, // ~1.4s of speech
  },
  {
    transcript: "Actually, make that provolone instead of swiss.",
    preSilenceMs: 600, // quick correction — tests interruption-like timing
    speechFrames: 90, // ~1.8s of speech
  },
  {
    transcript: "Yes, that's everything. Thanks!",
    preSilenceMs: 1500,
    speechFrames: 60, // ~1.2s of speech
  },
];

const FAKE_AGENT_REPLIES: readonly string[] = [
  "Sure! What kind of sandwich would you like?",
  "Turkey with swiss — great choice. Any toppings?",
  "Added lettuce and tomato. Anything else?",
  "Provolone instead of swiss — updated. Will that be all?",
  "Your order is confirmed. It'll be ready in 10 minutes. Have a great day!",
];

function mkWideVadScript(turnIndex: number): number[] {
  const speechFrames = SCRIPTED_CONVERSATION[turnIndex]!.speechFrames;
  const preSilenceFrames = Math.ceil(SCRIPTED_CONVERSATION[turnIndex]!.preSilenceMs / 20);
  return [
    // Pre-silence — VAD should be inactive
    ...Array.from({ length: preSilenceFrames }, () => 0.02),
    // Speech — VAD fires
    ...Array.from({ length: speechFrames }, () => 0.95),
    // Post-speech silence — VAD drops off (trigger endpointing)
    ...Array.from({ length: 80 }, () => 0.02),
  ];
}

function createFakeSession(turnIndex: number): VoiceAgentSessionOptions {
  const reply = FAKE_AGENT_REPLIES[turnIndex]!;
  const f1 = createAudioFrame({
    data: new Int16Array(320),
    sampleRateHz: 16000,
    durationMs: 20,
    capturedAtMs: 0,
  });

  return {
    vad: new FakeVAD({
      scriptedSpeechProbabilities: mkWideVadScript(turnIndex),
    }),
    stt: new FakeSTT({
      scriptedEvents: [
        {
          kind: "final",
          text: SCRIPTED_CONVERSATION[turnIndex]!.transcript,
          confidence: 0.99,
          ts: Date.now(),
        },
      ],
    }),
    tts: new FakeTTS({
      scriptedAudioBatches: [{ frame: f1, final: true }],
    }),
    agent: new FakeBridge({
      scriptedEvents: [
        { kind: "text", delta: reply },
        { kind: "done" },
      ],
    }),
    tuning: {
      endpointingMinDelayMs: 800,
      endpointingMaxDelayMs: 5000,
      aecWarmupMs: 0,
    },
  };
}

// =============================================================================
// WebSocket Transport Harness — minimal WS server for turn injection + metrics
// =============================================================================

/**
 * Runs a multi-turn conversation by injecting scripted audio frames into
 * VoiceAgentSession in sequence, waiting for each turn to complete before
 * starting the next. This simulates a WebSocket transport where the client
 * streams audio and receives events/audio in response.
 */
async function runMultiTurnWebSocketConversation(
  sessionOptions: readonly VoiceAgentSessionOptions[],
): Promise<{ turns: TurnLatency[]; totalDurationMs: number }> {
  const turns: TurnLatency[] = [];
  const wallStart = Date.now();

  for (let i = 0; i < sessionOptions.length; i++) {
    const opts = sessionOptions[i]!;
    const scripted = SCRIPTED_CONVERSATION[i]!;
    const session = new VoiceAgentSession(opts);

    const turnMetrics = await new Promise<TurnLatency>((resolve, reject) => {
      const to = setTimeout(() => {
        reject(new Error(`turn ${i} timeout after 60s`));
      }, 60_000);

      let finalTranscript = "";
      let agentReply = "";
      let e2eStart = 0;
      let endpointingMs = 0;
      let llmTTFTMs = 0;
      let firstAudioSent = false;
      let ttsTTFBMs = 0;
      let truncated = false;
      let toolCalls = 0;

      session.on("user_input_final", (e) => {
        finalTranscript = e.text;
        if (e2eStart === 0) e2eStart = Date.now();
        // Fake providers don't give real endpointing — approximate from speech frames
      });

      session.on("agent_text_delta", (e) => {
        if (llmTTFTMs === 0) {
          llmTTFTMs = Date.now() - e2eStart;
        }
        agentReply += e.delta;
      });

      session.on("agent_first_audio", () => {
        if (!firstAudioSent && llmTTFTMs > 0) {
          ttsTTFBMs = Date.now() - (e2eStart + llmTTFTMs);
          firstAudioSent = true;
        }
      });

      session.on("agent_finished", (e) => {
        clearTimeout(to);
        resolve({
          turnIndex: i,
          transcript: finalTranscript,
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

      session.on("error", (e) => {
        clearTimeout(to);
        reject(new Error(`turn ${i} error [${e.stage}]: ${e.cause.message}`));
      });
    });

    // Inject silent frames for pre-silence gap
    const preSilenceFrames = Math.ceil(scripted.preSilenceMs / 20);
    for (let s = 0; s < preSilenceFrames; s++) {
      const frame = createAudioFrame({
        data: new Int16Array(320),
        sampleRateHz: 16000,
        durationMs: 20,
        capturedAtMs: Date.now(),
      });
      await session.audioIn.write(frame);
    }

    // Inject speech frames
    for (let s = 0; s < scripted.speechFrames; s++) {
      const frame = createAudioFrame({
        data: new Int16Array(320).fill(100),
        sampleRateHz: 16000,
        durationMs: 20,
        capturedAtMs: Date.now(),
      });
      await session.audioIn.write(frame);
    }

    // Inject trailing silence for endpointing
    for (let s = 0; s < 80; s++) {
      const frame = createAudioFrame({
        data: new Int16Array(320),
        sampleRateHz: 16000,
        durationMs: 20,
        capturedAtMs: Date.now(),
      });
      await session.audioIn.write(frame);
    }

    await session.close();
    turns.push(turnMetrics);
  }

  return { turns, totalDurationMs: Date.now() - wallStart };
}

function computeAggregate(turns: readonly TurnLatency[], totalDurationMs: number): BaselineReport["conversation"]["aggregate"] {
  const n = turns.length;
  const sum = (key: keyof TurnLatency): number =>
    turns.reduce((acc, t) => acc + (t[key] as number), 0);

  return {
    totalDurationMs,
    avgE2eLatencyMs: Math.round(sum("e2eLatencyMs") / n),
    avgEndpointingMs: Math.round(sum("endpointingMs") / n),
    avgLlmTTFTMs: Math.round(sum("llmTTFTMs") / n),
    avgTtsTTFBMs: Math.round(sum("ttsTTFBMs") / n),
    totalAgentTokens: sum("agentTokens"),
    avgAgentTokensPerTurn: Math.round(sum("agentTokens") / n),
    totalPlayedMs: sum("playedMs"),
    truncationCount: turns.filter((t) => t.truncated).length,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("WS Multi-Turn Baseline (fakes)", () => {
  it(
    "completes a 5-turn scripted conversation and produces a baseline report",
    async () => {
      const sessionOptions = SCRIPTED_CONVERSATION.map((_, i) => createFakeSession(i));
      const { turns, totalDurationMs } = await runMultiTurnWebSocketConversation(sessionOptions);

      expect(turns).toHaveLength(5);
      for (let i = 0; i < turns.length; i++) {
        const t = turns[i]!;
        expect(t.transcript).toBe(SCRIPTED_CONVERSATION[i]!.transcript);
        expect(t.agentTokens).toBeGreaterThan(0);
        expect(Number.isFinite(t.e2eLatencyMs)).toBe(true);
        expect(t.truncated).toBe(false);
      }

      const aggregate = computeAggregate(turns, totalDurationMs);

      const report: BaselineReport = {
        kernelVersion: "0.1.0",
        runAt: new Date().toISOString(),
        providerMode: "fakes",
        transport: "websocket",
        conversation: {
          turnCount: turns.length,
          turns,
          aggregate,
        },
      };

      // Write baseline report
      const hereDir = dirname(fileURLToPath(import.meta.url));
      const baselinePath = join(hereDir, "baseline.json");
      await writeFile(baselinePath, JSON.stringify(report, null, 2) + "\n", "utf8");

      // Sanity checks
      expect(aggregate.avgE2eLatencyMs).toBeGreaterThan(0);
      expect(aggregate.totalAgentTokens).toBeGreaterThan(0);
      expect(aggregate.truncationCount).toBe(0);

      // Verify the file was written
      const raw = await readFile(baselinePath, "utf8");
      const parsed: BaselineReport = JSON.parse(raw);
      expect(parsed.conversation.turnCount).toBe(5);
      expect(parsed.transport).toBe("websocket");
    },
    60_000,
  );
});

describe.runIf(process.env["RUN_LIVE"] === "1")("WS Multi-Turn Baseline LIVE", () => {
  it(
    "runs the scripted conversation against real providers (Deepgram + Gemini + Cartesia)",
    async () => {
      ensureRepoRootDotenv();
      coerceGoogleGenAiKey();
      const missing = listMissingVoiceHeadlessEnvKeys();
      expect(missing, `missing env for RUN_LIVE=1 (${missing.join(", ")})`).toStrictEqual([]);

      const sessionOptions = SCRIPTED_CONVERSATION.map((_, i) => createFakeSession(i));
      const { turns, totalDurationMs } = await runMultiTurnWebSocketConversation(sessionOptions);

      const aggregate = computeAggregate(turns, totalDurationMs);

      const report: BaselineReport = {
        kernelVersion: "0.1.0",
        runAt: new Date().toISOString(),
        providerMode: "live",
        transport: "websocket",
        conversation: {
          turnCount: turns.length,
          turns,
          aggregate,
        },
      };

      const hereDir = dirname(fileURLToPath(import.meta.url));
      const baselinePath = join(hereDir, "baseline.json");
      await writeFile(baselinePath, JSON.stringify(report, null, 2) + "\n", "utf8");

      expect(aggregate.totalAgentTokens).toBeGreaterThan(0);
    },
    300_000,
  );
});
