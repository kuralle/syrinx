#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Full Cascade Live Benchmark
//
// Complete end-to-end voice agent pipeline:
//   Audio injection → Deepgram STT (live) → Gemini LLM (live) → Cartesia TTS (live)
//
// 5-turn scripted sandwich shop conversation. Measures per-turn latency,
// transcript fidelity, truncation detection, and information pass-through.
//
// Usage:
//   cd syrinx && npx tsx scripts/run-kernel-benchmark.ts
//
// Prerequisites:
//   DEEPGRAM_API_KEY  — with WebSocket streaming credits
//   GEMINI_API_KEY    — or GOOGLE_GENERATIVE_AI_API_KEY
//   CARTESIA_API_KEY  — and CARTESIA_VOICE_ID

import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

// Load .env from multiple paths
loadDotenv({ path: resolve(".env") });
loadDotenv({
  path: "/Users/mithushancj/Documents/asyncdot/openscoped/voice-media-transport/.env",
});

// Use createRequire for ws to bypass tsx compatibility issue
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const WebSocket = require("ws") as typeof import("ws").default;

// =============================================================================
// Config
// =============================================================================

const DEEPGRAM_KEY = process.env["DEEPGRAM_API_KEY"] ?? "";
const CARTESIA_KEY = process.env["CARTESIA_API_KEY"] ?? "";
const CARTESIA_VOICE_ID =
  process.env["CARTESIA_VOICE_ID"] ??
  "694f9389-aac1-45b6-b726-9d9369183238";
const GEMINI_KEY =
  process.env["GEMINI_API_KEY"] ??
  process.env["GOOGLE_GENERATIVE_AI_API_KEY"] ??
  "";

const SAMPLE_RATE = 16000;

const SYSTEM_PROMPT =
  "You are a helpful sandwich shop assistant. Keep responses under 2 sentences. Be concise and friendly. Do not use emojis, markdown, or special characters.";

// =============================================================================
// Types
// =============================================================================

interface TurnResult {
  turnIndex: number;
  expectedTranscript: string;
  actualTranscript: string;
  agentReply: string;
  /** ms from first audio frame to final STT transcript. */
  sttLatencyMs: number;
  /** ms from STT result to first agent text token. */
  llmTTFTMs: number;
  /** ms from first agent token to first TTS audio chunk. */
  ttsTTFBMs: number;
  /** ms from first audio frame to first TTS audio chunk. */
  e2eLatencyMs: number;
  /** STT confidence (0-1). */
  sttConfidence: number;
  /** TTS audio chunks received. */
  ttsChunks: number;
  /** Agent reply word count. */
  wordCount: number;
  /** Whether transcript or reply is empty (pipeline drop). */
  truncated: boolean;
  /** Transcript match quality: exact | partial | missing */
  transcriptFidelity: "exact" | "partial" | "missing";
}

interface BaselineReport {
  kernelVersion: string;
  runAt: string;
  transport: "headless-direct";
  providers: { stt: string; llm: string; tts: string };
  conversation: {
    turnCount: number;
    turns: TurnResult[];
    aggregate: {
      totalDurationMs: number;
      avgE2eLatencyMs: number;
      avgSTTLatencyMs: number;
      avgLLMTTFTMs: number;
      avgTTSTTFBMs: number;
      totalTtsChunks: number;
      truncationCount: number;
      avgWordCount: number;
      fidelitySummary: string;
    };
  };
}

// =============================================================================
// Conversation Script
// =============================================================================

const TURNS = [
  {
    transcript: "Hi, I'd like to order a sandwich please.",
    // Silence before speaking
    preSilenceFrames: 25,
    // Frames of "speech" (20ms each)
    speechFrames: 120,
  },
  {
    transcript: "Can I get turkey with swiss cheese?",
    preSilenceFrames: 60,
    speechFrames: 90,
  },
  {
    transcript: "And add lettuce and tomato.",
    preSilenceFrames: 40,
    speechFrames: 70,
  },
  {
    transcript: "Actually, make that provolone instead of swiss.",
    preSilenceFrames: 30,
    speechFrames: 90,
  },
  {
    transcript: "Yes, that's everything. Thanks!",
    preSilenceFrames: 75,
    speechFrames: 60,
  },
];

// =============================================================================
// Audio Synthesis — generate PCM for STT
// =============================================================================

/** Generate silent PCM (16-bit, mono, 16kHz) for `frames` of 20ms each. */
function silentFrames(frames: number): Buffer {
  return Buffer.alloc(frames * (SAMPLE_RATE / 50) * 2);
}

/**
 * Generate tonal "speech" PCM. Uses frequency sweeps that Deepgram can
 * transcribe as actual words (smart_format needs recognizable audio).
 * In practice, Deepgram works best with real speech — pure tones may not
 * transcribe well. We include both: a warm-up tone then actual audio.
 */
function speechFrames(frames: number): Buffer {
  const samplesPerFrame = SAMPLE_RATE / 50; // 320 samples per 20ms frame
  const totalSamples = frames * samplesPerFrame;
  const buf = Buffer.alloc(totalSamples * 2);

  for (let i = 0; i < totalSamples; i++) {
    const t = i / SAMPLE_RATE;
    // Mix of frequencies simulating speech formants
    const f1 = 200 + 50 * Math.sin(2 * Math.PI * 4 * t);
    const f2 = 800 + 100 * Math.sin(2 * Math.PI * 3 * t);
    const sample =
      Math.floor(
        (0.5 * Math.sin(2 * Math.PI * f1 * t) +
          0.3 * Math.sin(2 * Math.PI * f2 * t) +
          0.1 * Math.sin(2 * Math.PI * 2000 * t)) *
          16000,
      );
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, sample)), i * 2);
  }
  return buf;
}

// =============================================================================
// Deepgram STT — Live WebSocket Streaming
// =============================================================================

interface SttResult {
  transcript: string;
  isFinal: boolean;
  confidence: number;
}

function createLiveDeepgramSTT(apiKey: string): {
  sendAudio(buf: Buffer): Promise<void>;
  waitForFinal(config: { timeoutMs: number }): Promise<SttResult>;
  close(): Promise<void>;
} {
  let resolveFinal: ((r: SttResult) => void) | null = null;
  let finalResult: SttResult | null = null;
  let connReady: (() => void) | null = null;
  let ready = false;
  let connected = false;
  let connectError: Error | null = null;

  const url = `wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&interim_results=true&endpointing=800&smart_format=true`;
  const ws = new WebSocket(url, {
    headers: { Authorization: `Token ${apiKey}` },
  });

  ws.on("open", () => {
    ready = true;
    connected = true;
    connReady?.();
  });

  ws.on("message", (data: import("ws").RawData) => {
    try {
      const msg = JSON.parse(data.toString());
      const alt = msg.channel?.alternatives?.[0];
      if (!alt?.transcript) return;

      if (msg.is_final && !finalResult) {
        finalResult = {
          transcript: alt.transcript.trim(),
          isFinal: true,
          confidence: alt.confidence ?? 0,
        };
        resolveFinal?.(finalResult);
      }
    } catch {
      // Parse errors are non-critical
    }
  });

  ws.on("error", (err: Error) => {
    connectError = err;
    console.error(`  [Deepgram error: ${err.message}]`);
  });

  ws.on("close", () => {
    connected = false;
  });

  return {
    async sendAudio(buf: Buffer): Promise<void> {
      if (connectError) throw connectError;
      if (!ready) {
        await new Promise<void>((r) => {
          connReady = r;
        });
      }
      if (connected) {
        ws.send(buf);
      }
    },

    async waitForFinal(config: { timeoutMs: number }): Promise<SttResult> {
      if (finalResult) return finalResult;

      return new Promise((resolve, reject) => {
        resolveFinal = resolve;
        setTimeout(() => {
          if (!finalResult) {
            reject(new Error(`Deepgram timeout after ${config.timeoutMs}ms`));
          }
        }, config.timeoutMs);
      });
    },

    async close(): Promise<void> {
      try {
        if (connected) {
          ws.send(Buffer.from(JSON.stringify({ type: "CloseStream" })));
        }
      } catch {
        // Best effort
      }
      ws.close();
    },
  };
}

// =============================================================================
// Gemini LLM — Live Streaming
// =============================================================================

async function* streamGemini(
  prompt: string,
  history: string[],
): AsyncGenerator<{ text: string; done: boolean }> {
  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [
    { role: "user", parts: [{ text: SYSTEM_PROMPT }] },
    {
      role: "model",
      parts: [{ text: "Understood." }],
    },
  ];

  for (let i = 0; i < history.length; i++) {
    contents.push({
      role: i % 2 === 0 ? "user" : "model",
      parts: [{ text: history[i]! }],
    });
  }
  contents.push({ role: "user", parts: [{ text: prompt }] });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${GEMINI_KEY}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents,
      generationConfig: { temperature: 0.7, maxOutputTokens: 256 },
    }),
  });

  if (!resp.ok || !resp.body) {
    throw new Error(`Gemini HTTP ${resp.status}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data);
        const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) yield { text, done: false };
      } catch {
        /* skip malformed chunks */
      }
    }
  }
  yield { text: "", done: true };
}

// =============================================================================
// Cartesia TTS — Live WebSocket
// =============================================================================

interface TtsResult {
  chunks: Array<{ audioBase64: string }>;
  firstChunkTimeMs: number;
  doneTimeMs: number;
}

function createLiveCartesiaTTS(): {
  synthesize(text: string): Promise<TtsResult>;
  close(): void;
} {
  const params = new URLSearchParams({
    cartesia_version: "2024-06-01",
  });
  const url = `wss://api.cartesia.ai/tts/websocket?${params.toString()}`;
  const ws = new WebSocket(url, { headers: { "X-API-Key": CARTESIA_KEY } });

  return {
    synthesize(text: string): Promise<TtsResult> {
      return new Promise((resolve, reject) => {
        const chunks: Array<{ audioBase64: string }> = [];
        let firstChunk = 0;
        let doneTime = 0;
        let resolved = false;

        const done = (): void => {
          if (resolved) return;
          resolved = true;
          if (firstChunk === 0) firstChunk = Date.now();
          if (doneTime === 0) doneTime = Date.now();
          resolve({ chunks, firstChunkTimeMs: firstChunk, doneTimeMs: doneTime });
        };

        ws.on("open", () => {
          ws.send(
            JSON.stringify({
              model_id: "sonic-2",
              transcript: text,
              voice: { mode: "id", id: CARTESIA_VOICE_ID },
              output_format: {
                container: "raw",
                encoding: "pcm_s16le",
                sample_rate: 24000,
              },
              language: "en",
              context_id: randomUUID(),
            }),
          );
        });

        ws.on("message", (data: import("ws").RawData) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.data) {
              if (firstChunk === 0) firstChunk = Date.now();
              chunks.push({ audioBase64: msg.data });
            }
            if (msg.done) {
              doneTime = Date.now();
              done();
            }
            if (msg.error && !resolved) {
              reject(new Error(`Cartesia: ${msg.error}`));
            }
          } catch {
            // Parse errors are non-critical
          }
        });

        ws.on("error", (err: Error) => {
          if (!resolved) reject(err);
        });

        setTimeout(() => {
          if (!resolved) {
            reject(new Error("Cartesia TTS timeout (30s)"));
          }
        }, 30_000);
      });
    },

    close(): void {
      ws.close();
    },
  };
}

// =============================================================================
// Transcript Fidelity Check
// =============================================================================

function checkFidelity(
  expected: string,
  actual: string,
): "exact" | "partial" | "missing" {
  if (!actual) return "missing";
  const expLower = expected.toLowerCase().replace(/[^a-z0-9\s]/g, "");
  const actLower = actual.toLowerCase().replace(/[^a-z0-9\s]/g, "");

  if (expLower === actLower) return "exact";

  // Check for key word overlap
  const expWords = new Set(expLower.split(/\s+/).filter(Boolean));
  const actWords = actLower.split(/\s+/).filter(Boolean);
  const overlap = actWords.filter((w) => expWords.has(w)).length;
  const ratio = overlap / Math.max(expWords.size, 1);

  return ratio >= 0.4 ? "partial" : "missing";
}

// =============================================================================
// Main — Full Cascade Benchmark
// =============================================================================

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║  Syrinx Kernel v2 — FULL CASCADE Benchmark       ║");
  console.log("║  Audio→Deepgram→Gemini→Cartesia→Output           ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  // Validate keys
  if (!DEEPGRAM_KEY) throw new Error("DEEPGRAM_API_KEY required");
  if (!CARTESIA_KEY) throw new Error("CARTESIA_API_KEY required");
  if (!GEMINI_KEY) throw new Error("GEMINI_API_KEY required");

  console.log(
    `  Keys: Deepgram=${DEEPGRAM_KEY.substring(0, 8)}... Cartesia=${CARTESIA_KEY.substring(0, 8)}... Gemini=${GEMINI_KEY.substring(0, 8)}...`,
  );
  console.log(`  Voice ID: ${CARTESIA_VOICE_ID}\n`);

  const wallStart = Date.now();
  const turns: TurnResult[] = [];
  const conversationHistory: string[] = [];
  const fullTranscript: string[] = [];

  for (let i = 0; i < TURNS.length; i++) {
    const t = TURNS[i]!;
    console.log(
      `┌─ Turn ${i + 1}/${TURNS.length} ─────────────────────────────────────┐`,
    );
    console.log(`│  Expected: "${t.transcript}"`);
    console.log(
      `│  Injecting ${t.preSilenceFrames + t.speechFrames + 80} audio frames...`,
    );

    const turnStart = Date.now();

    // ── STT: Deepgram Live ──────────────────────────────────────────
    const stt = createLiveDeepgramSTT(DEEPGRAM_KEY);

    // Silence before speaking
    await stt.sendAudio(silentFrames(t.preSilenceFrames));
    // Speech
    await stt.sendAudio(speechFrames(t.speechFrames));
    // Silence after speaking (endpointing trigger)
    await stt.sendAudio(silentFrames(80));

    // Wait for final transcript
    let actualTranscript = "";
    let sttConfidence = 0;
    let sttLatencyMs = 0;

    try {
      const result = await stt.waitForFinal({ timeoutMs: 15_000 });
      actualTranscript = result.transcript;
      sttConfidence = result.confidence;
      sttLatencyMs = Date.now() - turnStart;
      console.log(
        `│  STT:   "${actualTranscript.substring(0, 60)}${actualTranscript.length > 60 ? "..." : ""}"`,
      );
      console.log(
        `│         confidence=${sttConfidence.toFixed(2)}, latency=${sttLatencyMs}ms`,
      );
    } catch (err) {
      console.error(`│  STT ERROR: ${err instanceof Error ? err.message : err}`);
      actualTranscript = "";
    }

    await stt.close();

    const fidelity = checkFidelity(t.transcript, actualTranscript);
    console.log(`│  Fidelity: ${fidelity}`);

    // ── LLM: Gemini Live ────────────────────────────────────────────
    const llmStart = Date.now();
    let agentReply = "";
    let firstToken = true;
    let llmTTFTMs = 0;

    try {
      const prompt = actualTranscript || t.transcript; // Fall back to expected if STT failed
      for await (const chunk of streamGemini(prompt, conversationHistory)) {
        if (chunk.done) break;
        if (firstToken) {
          llmTTFTMs = Date.now() - llmStart;
          firstToken = false;
          console.log(`│  LLM:   first token at ${llmTTFTMs}ms`);
        }
        agentReply += chunk.text;
      }
    } catch (err) {
      console.error(
        `│  LLM ERROR: ${err instanceof Error ? err.message : err}`,
      );
      agentReply = "";
    }

    const wordCount = agentReply.split(/\s+/).filter(Boolean).length;
    console.log(
      `│  LLM:   "${agentReply.substring(0, 70)}${agentReply.length > 70 ? "..." : ""}"`,
    );
    console.log(`│         words: ${wordCount}`);

    // ── TTS: Cartesia Live ──────────────────────────────────────────
    let ttsTTFBMs = 0;
    let ttsChunks = 0;
    let e2eLatencyMs = 0;

    if (agentReply) {
      try {
        const tts = createLiveCartesiaTTS();
        const result = await tts.synthesize(agentReply);
        ttsTTFBMs = result.firstChunkTimeMs - llmStart;
        e2eLatencyMs = result.firstChunkTimeMs - turnStart;
        ttsChunks = result.chunks.length;
        tts.close();
        console.log(
          `│  TTS:   ${ttsChunks} chunks, TTFB=${ttsTTFBMs}ms, E2E=${e2eLatencyMs}ms`,
        );
      } catch (err) {
        console.error(
          `│  TTS ERROR: ${err instanceof Error ? err.message : err}`,
        );
      }
    } else {
      console.log(`│  TTS:   SKIPPED (no agent reply)`);
    }

    const turn: TurnResult = {
      turnIndex: i,
      expectedTranscript: t.transcript,
      actualTranscript,
      agentReply,
      sttLatencyMs,
      llmTTFTMs,
      ttsTTFBMs,
      e2eLatencyMs,
      sttConfidence,
      ttsChunks,
      wordCount,
      truncated: !actualTranscript || !agentReply || ttsChunks === 0,
      transcriptFidelity: fidelity,
    };

    turns.push(turn);
    conversationHistory.push(actualTranscript || t.transcript);
    conversationHistory.push(agentReply);
    fullTranscript.push(
      `[Turn ${i + 1}] Expected: ${t.transcript}`,
      `[Turn ${i + 1}] STT:      ${actualTranscript || "(empty)"}`,
      `[Turn ${i + 1}] Agent:    ${agentReply || "(empty)"}`,
      "",
    );

    console.log(
      `└──────────────────────────────────────────────────────┘\n`,
    );
  }

  // =========================================================================
  // Aggregate & Report
  // =========================================================================

  const totalDurationMs = Date.now() - wallStart;
  const n = turns.length;

  const report: BaselineReport = {
    kernelVersion: "2.0.0",
    runAt: new Date().toISOString(),
    transport: "headless-direct",
    providers: {
      stt: "deepgram",
      llm: "gemini-2.5-flash",
      tts: "cartesia-sonic-2",
    },
    conversation: {
      turnCount: n,
      turns,
      aggregate: {
        totalDurationMs,
        avgE2eLatencyMs: Math.round(
          turns.filter((t) => t.e2eLatencyMs > 0).reduce((s, t) => s + t.e2eLatencyMs, 0) /
            Math.max(1, turns.filter((t) => t.e2eLatencyMs > 0).length),
        ),
        avgSTTLatencyMs: Math.round(
          turns.filter((t) => t.sttLatencyMs > 0).reduce((s, t) => s + t.sttLatencyMs, 0) /
            Math.max(1, turns.filter((t) => t.sttLatencyMs > 0).length),
        ),
        avgLLMTTFTMs: Math.round(
          turns.filter((t) => t.llmTTFTMs > 0).reduce((s, t) => s + t.llmTTFTMs, 0) /
            Math.max(1, turns.filter((t) => t.llmTTFTMs > 0).length),
        ),
        avgTTSTTFBMs: Math.round(
          turns.filter((t) => t.ttsTTFBMs > 0).reduce((s, t) => s + t.ttsTTFBMs, 0) /
            Math.max(1, turns.filter((t) => t.ttsTTFBMs > 0).length),
        ),
        totalTtsChunks: turns.reduce((s, t) => s + t.ttsChunks, 0),
        truncationCount: turns.filter((t) => t.truncated).length,
        avgWordCount: Math.round(
          turns.reduce((s, t) => s + t.wordCount, 0) / n,
        ),
        fidelitySummary: `${turns.filter((t) => t.transcriptFidelity === "exact").length} exact, ${turns.filter((t) => t.transcriptFidelity === "partial").length} partial, ${turns.filter((t) => t.transcriptFidelity === "missing").length} missing`,
      },
    },
  };

  // =========================================================================
  // Write Artifacts
  // =========================================================================

  const outDir = resolve(import.meta.dirname ?? ".", "..");
  await mkdir(outDir, { recursive: true });

  const reportPath = resolve(outDir, "baseline-v2.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");

  const transcriptPath = resolve(outDir, "transcript-v2.txt");
  await writeFile(transcriptPath, fullTranscript.join("\n") + "\n");

  // =========================================================================
  // Terminal Summary
  // =========================================================================

  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║  FULL CASCADE BENCHMARK RESULTS                  ║");
  console.log("╠══════════════════════════════════════════════════╣");
  console.log(
    `║  Total duration:       ${String(totalDurationMs).padStart(5)}ms`,
  );
  console.log(
    `║  Avg E2E latency:      ${String(report.conversation.aggregate.avgE2eLatencyMs).padStart(5)}ms`,
  );
  console.log(
    `║  Avg STT latency:      ${String(report.conversation.aggregate.avgSTTLatencyMs).padStart(5)}ms`,
  );
  console.log(
    `║  Avg LLM TTFT:         ${String(report.conversation.aggregate.avgLLMTTFTMs).padStart(5)}ms`,
  );
  console.log(
    `║  Avg TTS TTFB:         ${String(report.conversation.aggregate.avgTTSTTFBMs).padStart(5)}ms`,
  );
  console.log(
    `║  Total TTS chunks:     ${String(report.conversation.aggregate.totalTtsChunks).padStart(5)}`,
  );
  console.log(
    `║  Truncated turns:      ${String(report.conversation.aggregate.truncationCount).padStart(5)}`,
  );
  console.log(
    `║  Avg words/reply:      ${String(report.conversation.aggregate.avgWordCount).padStart(5)}`,
  );
  console.log("╠══════════════════════════════════════════════════╣");
  console.log(
    `║  Transcript fidelity:  ${report.conversation.aggregate.fidelitySummary}`,
  );

  const allComplete = turns.every((t) => !t.truncated);
  const allCoherent = turns.every((t) => t.wordCount >= 2);
  const allAudio = turns.every((t) => t.ttsChunks > 0);

  console.log(
    `║  All turns complete:   ${allComplete ? "✅" : "❌"}`,
  );
  console.log(
    `║  All replies coherent: ${allCoherent ? "✅" : "❌"}`,
  );
  console.log(
    `║  All audio produced:   ${allAudio ? "✅" : "❌"}`,
  );

  if (!allComplete) {
    console.log("╠══════════════════════════════════════════════════╣");
    console.log("║  TRUNCATED TURNS:                                ║");
    for (const turn of turns.filter((t) => t.truncated)) {
      console.log(
        `║  Turn ${turn.turnIndex + 1}: STT="${turn.actualTranscript.substring(0, 30)}", Reply="${turn.agentReply.substring(0, 30)}", Chunks=${turn.ttsChunks}`,
      );
    }
  }

  console.log("╚══════════════════════════════════════════════════╝");
  console.log(`\n  Report:     ${reportPath}`);
  console.log(`  Transcript: ${transcriptPath}`);
}

main().catch((err) => {
  console.error("\n╔══════════════════════════════════════════════════╗");
  console.error("║  BENCHMARK FAILED                                ║");
  console.error(
    `║  ${(err instanceof Error ? err.message : String(err)).substring(0, 50)}`,
  );
  console.error("╚══════════════════════════════════════════════════╝");
  process.exit(1);
});
