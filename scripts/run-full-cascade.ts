#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Full Cascade w/ Real Audio
//
// Uses actual WAV audio files → Deepgram STT → Gemini LLM → Cartesia TTS
//
// Usage:
//   cd syrinx && npx tsx scripts/run-full-cascade.ts

import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const WebSocket = require("ws") as typeof import("ws").default;

// Load .env
loadDotenv({ path: resolve(".env") });

const DEEPGRAM_KEY = process.env["DEEPGRAM_API_KEY"] ?? "";
const GEMINI_KEY = process.env["GEMINI_API_KEY"] ?? process.env["GOOGLE_GENERATIVE_AI_API_KEY"] ?? "";
const CARTESIA_KEY = process.env["CARTESIA_API_KEY"] ?? "";
const CARTESIA_VOICE_ID = process.env["CARTESIA_VOICE_ID"] ?? "694f9389-aac1-45b6-b726-9d9369183238";

// WAV files — real human speech recordings
const WAV_FILES = [
  "/Users/mithushancj/Documents/asyncdot/openscoped/voice-media-transport/research/agents/tests/test_realtime/hello_world.wav",
  "/Users/mithushancj/Documents/asyncdot/openscoped/voice-media-transport/research/agents/tests/test_realtime/weather_question.wav",
  "/Users/mithushancj/Documents/asyncdot/openscoped/voice-media-transport/research/agents/tests/change-sophie.wav",
  "/Users/mithushancj/Documents/asyncdot/openscoped/voice-media-transport/research/agents-js/plugins/test/src/long.wav",
];

// =============================================================================
// Deepgram STT — transcribe a WAV file
// =============================================================================

function transcribeWav(wavPath: string): Promise<{ transcript: string; confidence: number; durationMs: number }> {
  return new Promise((resolve, reject) => {
    const buf = readFileSync(wavPath);
    const sampleRate = buf.readUInt32LE(24);
    const pcm = buf.subarray(44);
    const totalSamples = pcm.length / 2;
    const durationSec = totalSamples / sampleRate;

    const ws = new WebSocket(
      `wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=${sampleRate}&interim_results=true&endpointing=600&smart_format=true`,
      { headers: { Authorization: `Token ${DEEPGRAM_KEY}` } },
    );

    const start = Date.now();
    let result = "";
    let confidence = 0;
    let closeStreamTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => settle("reject", new Error("STT timeout")), 40_000);
    let settled = false;

    function settle(kind: "resolve", value: { transcript: string; confidence: number; durationMs: number }): void;
    function settle(kind: "reject", value: Error): void;
    function settle(
      kind: "resolve" | "reject",
      value: { transcript: string; confidence: number; durationMs: number } | Error,
    ): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (closeStreamTimer) clearTimeout(closeStreamTimer);
      if (kind === "resolve") {
        resolve(value as { transcript: string; confidence: number; durationMs: number });
      } else {
        reject(value);
      }
    }

    ws.on("open", () => {
      const chunkSize = Math.floor(sampleRate / 50) * 2;
      for (let i = 0; i < pcm.length; i += chunkSize) {
        ws.send(pcm.subarray(i, Math.min(i + chunkSize, pcm.length)));
      }
      // Send trailing silence for endpointing (1.5s), then CloseStream
      const silenceFrames = Math.floor(sampleRate / 50) * 75;
      ws.send(Buffer.alloc(silenceFrames * 2));
      // Give Deepgram time to process trailing audio before closing
      closeStreamTimer = setTimeout(() => {
        try { ws.send(Buffer.from(JSON.stringify({ type: "CloseStream" }))); } catch {}
      }, 3000);
    });

    ws.on("message", (data: import("ws").RawData) => {
      try {
        const msg = JSON.parse(data.toString());
        const alt = msg.channel?.alternatives?.[0];
        if (alt?.transcript) {
          result = alt.transcript.trim();
          confidence = alt.confidence ?? 0;
          if (!msg.is_final) {
            console.log(`  [interim] "${result}"`);
          }
        }
        if (msg.is_final) {
          console.log(`  [FINAL]   "${result}" (conf: ${confidence.toFixed(2)})`);
          ws.close();
          settle("resolve", { transcript: result, confidence, durationMs: Date.now() - start });
        }
      } catch {}
    });

    ws.on("close", () => {
      settle("resolve", { transcript: result, confidence, durationMs: Date.now() - start });
    });

    ws.on("error", (err: Error) => {
      settle("reject", err);
    });
  });
}

// =============================================================================
// Gemini LLM — streaming
// =============================================================================

const SYSTEM_PROMPT = "You are a helpful voice assistant. Keep responses under 2 sentences.";

async function* streamGemini(prompt: string): AsyncGenerator<{ text: string; done: boolean }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${GEMINI_KEY}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        { role: "user", parts: [{ text: SYSTEM_PROMPT }] },
        { role: "model", parts: [{ text: "Understood." }] },
        { role: "user", parts: [{ text: prompt }] },
      ],
      generationConfig: { temperature: 0.7, maxOutputTokens: 256 },
    }),
  });

  if (!resp.ok || !resp.body) throw new Error(`Gemini HTTP ${resp.status}`);

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
      } catch {}
    }
  }
  yield { text: "", done: true };
}

// =============================================================================
// Cartesia TTS — streaming WebSocket
// =============================================================================

function synthesizeCartesia(text: string): Promise<{ audioBytes: number; chunks: number; ttfbMs: number; totalMs: number }> {
  return new Promise((resolve, reject) => {
    const url = "wss://api.cartesia.ai/tts/websocket?cartesia_version=2024-06-10";
    const start = Date.now();
    const ws = new WebSocket(url, { headers: { "X-API-Key": CARTESIA_KEY } });
    let chunks = 0;
    let audioBytes = 0;
    let ttfbMs = 0;
    let ttfbCaptured = false;
    const timeout = setTimeout(() => settle("reject", new Error("Cartesia TTS timeout")), 30_000);
    let settled = false;

    function settle(kind: "resolve", value: { audioBytes: number; chunks: number; ttfbMs: number; totalMs: number }): void;
    function settle(kind: "reject", value: Error): void;
    function settle(
      kind: "resolve" | "reject",
      value: { audioBytes: number; chunks: number; ttfbMs: number; totalMs: number } | Error,
    ): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (kind === "resolve") {
        resolve(value as { audioBytes: number; chunks: number; ttfbMs: number; totalMs: number });
      } else {
        reject(value);
      }
    }

    ws.on("open", () => {
      ws.send(JSON.stringify({
        model_id: "sonic-2",
        transcript: text,
        voice: { mode: "id", id: CARTESIA_VOICE_ID },
        output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: 24000 },
        language: "en",
        context_id: randomUUID(),
      }));
    });

    ws.on("message", (data: import("ws").RawData) => {
      const msg = JSON.parse(data.toString());
      if (msg.data) {
        const audio = Buffer.from(msg.data, "base64");
        chunks++;
        audioBytes += audio.length;
        if (!ttfbCaptured) {
          ttfbMs = Date.now() - start;
          ttfbCaptured = true;
        }
      }
      if (msg.done) {
        ws.close();
        settle("resolve", { audioBytes, chunks, ttfbMs, totalMs: Date.now() - start });
      }
    });

    ws.on("error", (err: Error) => settle("reject", err));
  });
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║  FULL CASCADE w/ Real Audio                      ║");
  console.log("║  WAV → Deepgram → Gemini → Cartesia TTS          ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  if (!DEEPGRAM_KEY) throw new Error("DEEPGRAM_API_KEY required");
  if (!GEMINI_KEY) throw new Error("GEMINI_API_KEY required");
  if (!CARTESIA_KEY) throw new Error("CARTESIA_API_KEY required");

  const results: Array<{
    file: string;
    sttTranscript: string;
    sttConfidence: number;
    sttMs: number;
    agentReply: string;
    llmTTFTMs: number;
    ttsTTFBMs: number;
    ttsChunks: number;
    ttsBytes: number;
    ttsMs: number;
    e2eMs: number;
  }> = [];

  for (const wavPath of WAV_FILES) {
    const fileName = wavPath.split("/").pop()!;
    console.log(`\n── ${fileName} ──`);

    // STT
    const wallStart = Date.now();
    let stt: { transcript: string; confidence: number; durationMs: number };
    try {
      stt = await transcribeWav(wavPath);
      console.log(`  STT: "${stt.transcript}" (${stt.confidence.toFixed(2)}, ${stt.durationMs}ms)`);
    } catch (err) {
      console.error(`  STT ERROR: ${err}`);
      continue;
    }

    if (!stt.transcript) {
      console.log("  (empty transcript, skipping LLM)");
      results.push({
        file: fileName,
        sttTranscript: "(empty)",
        sttConfidence: 0,
        sttMs: stt.durationMs,
        agentReply: "",
        llmTTFTMs: 0,
        ttsTTFBMs: 0,
        ttsChunks: 0,
        ttsBytes: 0,
        ttsMs: 0,
        e2eMs: Date.now() - wallStart,
      });
      continue;
    }

    // LLM
    const llmStart = Date.now();
    let reply = "";
    let firstToken = true;
    let ttft = 0;
    try {
      for await (const chunk of streamGemini(stt.transcript)) {
        if (chunk.done) break;
        if (firstToken) { ttft = Date.now() - llmStart; firstToken = false; }
        reply += chunk.text;
      }
    } catch (err) {
      console.error(`  LLM ERROR: ${err}`);
    }

    console.log(`  LLM: "${reply}" (TTFT=${ttft}ms)`);

    // TTS (Cartesia)
    let ttsResult = { audioBytes: 0, chunks: 0, ttfbMs: 0, totalMs: 0 };
    if (reply) {
      try {
        ttsResult = await synthesizeCartesia(reply);
        console.log(`  TTS: ${ttsResult.chunks} chunks, ${(ttsResult.audioBytes / 1024).toFixed(0)}KB, TTFB=${ttsResult.ttfbMs}ms, total=${ttsResult.totalMs}ms`);
      } catch (err) {
        console.error(`  TTS ERROR: ${err}`);
      }
    }

    const e2e = Date.now() - wallStart;
    console.log(`  E2E:  ${e2e}ms (STT→LLM→TTS)`);

    results.push({
      file: fileName,
      sttTranscript: stt.transcript,
      sttConfidence: stt.confidence,
      sttMs: stt.durationMs,
      agentReply: reply,
      llmTTFTMs: ttft,
      ttsTTFBMs: ttsResult.ttfbMs,
      ttsChunks: ttsResult.chunks,
      ttsBytes: ttsResult.audioBytes,
      ttsMs: ttsResult.totalMs,
      e2eMs: e2e,
    });
  }

  // Summary
  console.log("\n╔════════════════════════════════════════════════════════════════════════╗");
  console.log("║  RESULTS                                                               ║");
  console.log("╠════════════════════════════════════════════════════════════════════════╣");
  for (const r of results) {
    const sttOk = r.sttTranscript.length > 0 ? "✅" : "❌";
    const llmOk = r.agentReply.length > 0 ? "✅" : "❌";
    const ttsOk = r.ttsChunks > 0 ? "✅" : "❌";
    console.log(`║  ${r.file.substring(0, 18).padEnd(18)} STT:${sttOk} LLM:${llmOk} TTS:${ttsOk}`);
    console.log(`║    STT:${String(r.sttMs).padStart(5)}ms  LLM_TTFT:${String(r.llmTTFTMs).padStart(4)}ms  TTS_TTFB:${String(r.ttsTTFBMs).padStart(4)}ms  E2E:${String(r.e2eMs).padStart(5)}ms`);
  }
  console.log("╚════════════════════════════════════════════════════════════════════════╝");

  await writeFile(
    resolve(import.meta.dirname ?? ".", "..", "cascade-results.json"),
    JSON.stringify(results, null, 2) + "\n",
  );
}

main().catch((err) => { console.error("FAIL:", err); process.exit(1); });
