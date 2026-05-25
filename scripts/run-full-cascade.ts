#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Full Cascade w/ Real Audio
//
// Uses actual WAV audio files → Deepgram STT → Gemini LLM → Cartesia TTS
// (Cartesia TTS blocked on key credits; mock output used for E2E measurement)
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

    ws.on("open", () => {
      const chunkSize = Math.floor(sampleRate / 50) * 2;
      for (let i = 0; i < pcm.length; i += chunkSize) {
        ws.send(pcm.subarray(i, Math.min(i + chunkSize, pcm.length)));
      }
      // Send trailing silence for endpointing (1.5s), then CloseStream
      const silenceFrames = Math.floor(sampleRate / 50) * 75;
      ws.send(Buffer.alloc(silenceFrames * 2));
      // Give Deepgram time to process trailing audio before closing
      setTimeout(() => {
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
          resolve({ transcript: result, confidence, durationMs: Date.now() - start });
        }
      } catch {}
    });

    ws.on("close", () => {
      resolve({ transcript: result, confidence, durationMs: Date.now() - start });
    });

    ws.on("error", (err: Error) => {
      reject(err);
    });

    setTimeout(() => reject(new Error("STT timeout")), 40_000);
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
// Main
// =============================================================================

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║  FULL CASCADE w/ Real Audio                      ║");
  console.log("║  WAV → Deepgram → Gemini → Output                ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  if (!DEEPGRAM_KEY) throw new Error("DEEPGRAM_API_KEY required");
  if (!GEMINI_KEY) throw new Error("GEMINI_API_KEY required");

  const results: Array<{
    file: string;
    sttTranscript: string;
    sttConfidence: number;
    sttMs: number;
    agentReply: string;
    llmTTFTMs: number;
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

    const e2e = Date.now() - wallStart;
    console.log(`  LLM: "${reply}" (TTFT=${ttft}ms)`);
    console.log(`  E2E:  ${e2e}ms (STT→LLM→done)`);

    results.push({
      file: fileName,
      sttTranscript: stt.transcript,
      sttConfidence: stt.confidence,
      sttMs: stt.durationMs,
      agentReply: reply,
      llmTTFTMs: ttft,
      e2eMs: e2e,
    });
  }

  // Summary
  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║  RESULTS                                         ║");
  console.log("╠══════════════════════════════════════════════════╣");
  for (const r of results) {
    const sttOk = r.sttTranscript.length > 0 ? "✅" : "❌";
    const llmOk = r.agentReply.length > 0 ? "✅" : "❌";
    console.log(`║  ${r.file.substring(0, 20).padEnd(20)} STT:${sttOk} LLM:${llmOk} E2E:${String(r.e2eMs).padStart(5)}ms TTFT:${String(r.llmTTFTMs).padStart(4)}ms`);
  }
  console.log("╚══════════════════════════════════════════════════╝");

  await writeFile(
    resolve(import.meta.dirname ?? ".", "..", "cascade-results.json"),
    JSON.stringify(results, null, 2) + "\n",
  );
}

main().catch((err) => { console.error("FAIL:", err); process.exit(1); });
