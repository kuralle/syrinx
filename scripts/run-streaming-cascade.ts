#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Streaming Cascade (Multi-Turn)
//
// Simulates real speech engine behavior:
//   WAV → Deepgram STT → Gemini LLM (streaming deltas) → Cartesia TTS (streaming)
//
// LLM deltas are forwarded to Cartesia incrementally with continue:true,
// then flushed with continue:false. Audio streams back as it's generated.
//
// Usage:
//   cd syrinx && npx tsx scripts/run-streaming-cascade.ts

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const WebSocket = require("ws") as typeof import("ws").default;

loadDotenv({ path: resolve(".env") });

const DEEPGRAM_KEY = process.env["DEEPGRAM_API_KEY"] ?? "";
const GEMINI_KEY = process.env["GEMINI_API_KEY"] ?? process.env["GOOGLE_GENERATIVE_AI_API_KEY"] ?? "";
const CARTESIA_KEY = process.env["CARTESIA_API_KEY"] ?? "";
const CARTESIA_VOICE_ID = process.env["CARTESIA_VOICE_ID"] ?? "c2ac25f9-ecc4-4f56-9095-651354df60c0";

const WAV_FILES = [
  "/Users/mithushancj/Documents/asyncdot/openscoped/voice-media-transport/research/agents/tests/test_realtime/hello_world.wav",
  "/Users/mithushancj/Documents/asyncdot/openscoped/voice-media-transport/research/agents/tests/test_realtime/weather_question.wav",
  "/Users/mithushancj/Documents/asyncdot/openscoped/voice-media-transport/research/agents/tests/change-sophie.wav",
];

// =============================================================================
// Deepgram STT
// =============================================================================

function transcribeWav(wavPath: string): Promise<{ transcript: string; durationMs: number }> {
  return new Promise((resolve, reject) => {
    let buf: Buffer;
    try {
      buf = readFileSync(wavPath);
    } catch (e) {
      reject(e);
      return;
    }
    const sampleRate = buf.readUInt32LE(24);
    const pcm = buf.subarray(44);

    const ws = new WebSocket(
      `wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=${sampleRate}&interim_results=true&endpointing=600&smart_format=true`,
      { headers: { Authorization: `Token ${DEEPGRAM_KEY}` } },
    );

    const start = Date.now();
    let result = "";
    let closeStreamTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => settle("reject", new Error("STT timeout")), 40_000);
    let settled = false;

    function settle(kind: "resolve", value: { transcript: string; durationMs: number }): void;
    function settle(kind: "reject", value: Error): void;
    function settle(kind: "resolve" | "reject", value: { transcript: string; durationMs: number } | Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (closeStreamTimer) clearTimeout(closeStreamTimer);
      if (kind === "resolve") {
        resolve(value as { transcript: string; durationMs: number });
      } else {
        reject(value);
      }
    }

    ws.on("open", () => {
      const chunkSize = Math.floor(sampleRate / 50) * 2;
      for (let i = 0; i < pcm.length; i += chunkSize) {
        ws.send(pcm.subarray(i, Math.min(i + chunkSize, pcm.length)));
      }
      const silenceFrames = Math.floor(sampleRate / 50) * 75;
      ws.send(Buffer.alloc(silenceFrames * 2));
      closeStreamTimer = setTimeout(() => {
        try { ws.send(Buffer.from(JSON.stringify({ type: "CloseStream" }))); } catch {}
      }, 3000);
    });

    ws.on("message", (data: import("ws").RawData) => {
      try {
        const msg = JSON.parse(data.toString());
        const alt = msg.channel?.alternatives?.[0];
        if (alt?.transcript) result = alt.transcript.trim();
        if (msg.is_final) {
          ws.close();
          settle("resolve", { transcript: result, durationMs: Date.now() - start });
        }
      } catch {}
    });

    ws.on("close", () => settle("resolve", { transcript: result, durationMs: Date.now() - start }));
    ws.on("error", (err: Error) => settle("reject", err));
  });
}

// =============================================================================
// Streaming cascade: LLM deltas → Cartesia streaming TTS
// =============================================================================

const SYSTEM_PROMPT = "You are a helpful voice assistant. Keep responses under 2 sentences.";

async function streamingTurn(transcript: string): Promise<{
  reply: string;
  llmTTFT: number;
  ttsTTFB: number;
  ttsChunks: number;
  ttsBytes: number;
  ttsTotal: number;
  deltaCount: number;
  e2e: number;
}> {
  const turnId = randomUUID();

  // --- Connect to Cartesia upfront ---
  const cartesiaStart = Date.now();
  const cartesiaWs = new WebSocket(
    "wss://api.cartesia.ai/tts/websocket?cartesia_version=2024-06-10",
    { headers: { "X-API-Key": CARTESIA_KEY } },
  );

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cartesiaWs.close();
      reject(new Error("Cartesia connect timeout"));
    }, 10_000);

    cartesiaWs.once("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    cartesiaWs.once("error", (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  const cartesiaConnectMs = Date.now() - cartesiaStart;

  // Track TTS audio
  let ttsChunks = 0;
  let ttsBytes = 0;
  let ttsTTFB = 0;
  let ttsTTFBCaptured = false;
  let ttsDone = false;

  cartesiaWs.on("message", (data: import("ws").RawData) => {
    const msg = JSON.parse(data.toString());
    if (msg.data) {
      const audio = Buffer.from(msg.data, "base64");
      ttsChunks++;
      ttsBytes += audio.length;
      if (!ttsTTFBCaptured) {
        ttsTTFB = Date.now() - cartesiaStart;
        ttsTTFBCaptured = true;
      }
    }
    if (msg.done) {
      ttsDone = true;
      cartesiaWs.close();
    }
  });

  // --- Stream Gemini LLM, forward deltas to Cartesia ---
  const llmStart = Date.now();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${GEMINI_KEY}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        { role: "user", parts: [{ text: SYSTEM_PROMPT }] },
        { role: "model", parts: [{ text: "Understood." }] },
        { role: "user", parts: [{ text: transcript }] },
      ],
      generationConfig: { temperature: 0.7, maxOutputTokens: 256 },
    }),
  });

  if (!resp.ok || !resp.body) throw new Error(`Gemini HTTP ${resp.status}`);

  let reply = "";
  let firstToken = true;
  let ttft = 0;
  let deltaCount = 0;

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ttsFirstDeltaSent = false;

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
        if (text) {
          if (firstToken) { ttft = Date.now() - llmStart; firstToken = false; }
          reply += text;
          deltaCount++;

          // Forward delta to Cartesia with continue:true
          cartesiaWs.send(JSON.stringify({
            model_id: "sonic-3",
            transcript: text,
            voice: { mode: "id", id: CARTESIA_VOICE_ID },
            output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: 16000 },
            language: "en",
            context_id: turnId,
            continue: true,
          }));
        }
      } catch {}
    }
  }

  // Flush: signal end of text stream
  cartesiaWs.send(JSON.stringify({
    model_id: "sonic-3",
    transcript: "",
    voice: { mode: "id", id: CARTESIA_VOICE_ID },
    output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: 16000 },
    language: "en",
    context_id: turnId,
    continue: false,
    flush: true,
  }));

  // Wait for Cartesia to finish
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      cartesiaWs.close();
      resolve();
    }, 10_000);
    cartesiaWs.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });

  const e2e = Date.now() - llmStart;

  return {
    reply,
    llmTTFT: ttft,
    ttsTTFB,
    ttsChunks,
    ttsBytes,
    ttsTotal: ttsTTFBCaptured ? e2e : 0,
    deltaCount,
    e2e,
  };
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║  STREAMING CASCADE (Multi-Turn)                           ║");
  console.log("║  WAV → Deepgram → Gemini (deltas) → Cartesia (streaming)  ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  if (!DEEPGRAM_KEY) throw new Error("DEEPGRAM_API_KEY required");
  if (!GEMINI_KEY) throw new Error("GEMINI_API_KEY required");
  if (!CARTESIA_KEY) throw new Error("CARTESIA_API_KEY required");

  for (const wavPath of WAV_FILES) {
    const fileName = wavPath.split("/").pop()!;
    console.log(`── ${fileName} ──`);

    // STT
    const wallStart = Date.now();
    let stt: { transcript: string; durationMs: number };
    try {
      stt = await transcribeWav(wavPath);
      console.log(`  STT: "${stt.transcript}" (${stt.durationMs}ms)`);
    } catch (err) {
      console.error(`  STT ERROR: ${err}`);
      continue;
    }

    if (!stt.transcript) {
      console.log("  (empty transcript, skipping)");
      continue;
    }

    // Streaming LLM → Cartesia
    try {
      const result = await streamingTurn(stt.transcript);
      console.log(`  LLM: "${result.reply}" (TTFT=${result.llmTTFT}ms, ${result.deltaCount} deltas)`);
      console.log(`  TTS: ${result.ttsChunks} chunks, ${(result.ttsBytes / 1024).toFixed(0)}KB, TTFB=${result.ttsTTFB}ms`);
      console.log(`  E2E (LLM→TTS): ${result.e2e}ms  |  Full: ${Date.now() - wallStart}ms`);
    } catch (err) {
      console.error(`  STREAMING ERROR: ${err}`);
    }
  }

  console.log("\nDone.");
}

main().catch((err) => { console.error("FAIL:", err); process.exit(1); });
