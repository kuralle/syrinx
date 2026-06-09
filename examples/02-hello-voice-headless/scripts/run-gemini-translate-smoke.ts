// SPDX-License-Identifier: MIT
//
// Live Gemini Live Translate smoke: English audio → Spanish speech + transcript.

import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createGeminiTranslateSession,
  GEMINI_TRANSLATE_MODEL,
} from "@kuralle-syrinx/realtime";

import { ensureRepoRootDotenv, readPcm16Mono16kWav } from "../src/run-one-turn.js";

const require = createRequire(import.meta.url);
const { WaveFile } = require("wavefile") as typeof import("wavefile");

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const FIXTURE_PATH = join(PKG_ROOT, "test", "fixtures", "university-cs-masters-deadline.wav");
const OUTPUT_DIR = join(PKG_ROOT, "test", "performance", "runs", "gemini-translate-smoke");
const FRAME_SAMPLES = 320;
const OUTPUT_SAMPLE_RATE_HZ = 24_000;
const TARGET_LANGUAGE = "es";

interface TimelineEntry {
  readonly atMs: number;
  readonly event: string;
  readonly detail?: string;
}

function pcmToBytes(samples: Readonly<Int16Array>): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}

function sliceFramePcm(samples: Readonly<Int16Array>, offset: number): Int16Array {
  const end = Math.min(offset + FRAME_SAMPLES, samples.length);
  const frame = new Int16Array(FRAME_SAMPLES);
  if (end > offset) frame.set(samples.subarray(offset, end));
  return frame;
}

function mergeBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function writePcm16Wav(path: string, chunks: readonly Uint8Array[], sampleRateHz: number): Promise<void> {
  const bytes = mergeBytes(chunks);
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const wav = new WaveFile();
  wav.fromScratch(1, sampleRateHz, "16", samples);
  return writeFile(path, Buffer.from(wav.toBuffer()));
}

function isNonSilentAudio(chunks: readonly Uint8Array[]): boolean {
  const bytes = mergeBytes(chunks);
  if (bytes.byteLength < 4) return false;
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  let peak = 0;
  for (const sample of samples) {
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
  }
  return peak > 100;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mergeTranscript(existing: string, next: string): string {
  if (!existing) return next;
  if (next.startsWith(existing)) return next;
  if (existing.endsWith(next) || existing.includes(next)) return existing;
  return `${existing} ${next}`.trim();
}

async function expectedSpanishReference(apiKey: string, englishInput: string): Promise<string> {
  const repoRoot = resolve(SCRIPT_DIR, "../../..");
  const genaiPath = require.resolve("@google/genai", {
    paths: [resolve(repoRoot, "packages/realtime")],
  });
  const { GoogleGenAI } = await import(genaiPath);
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: `Translate to Spanish (one sentence): ${englishInput}`,
  });
  return response.text?.trim() ?? "";
}

async function verifyAudioMatchesSpanish(
  apiKey: string,
  chunks: readonly Uint8Array[],
  sampleRateHz: number,
  expectedSpanish: string,
): Promise<boolean> {
  const repoRoot = resolve(SCRIPT_DIR, "../../..");
  const genaiPath = require.resolve("@google/genai", {
    paths: [resolve(repoRoot, "packages/realtime")],
  });
  const { GoogleGenAI } = await import(genaiPath);

  const bytes = mergeBytes(chunks);
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const wav = new WaveFile();
  wav.fromScratch(1, sampleRateHz, "16", samples);
  const wavBase64 = Buffer.from(wav.toBuffer()).toString("base64");

  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [{
      parts: [
        { inlineData: { mimeType: "audio/wav", data: wavBase64 } },
        {
          text:
            `Does this spoken audio convey the same meaning as this Spanish reference? ` +
            `Reference: "${expectedSpanish}". Answer only YES or NO.`,
        },
      ],
    }],
  });
  return /^yes\b/i.test(response.text?.trim() ?? "");
}

async function transcribeOutputAudio(
  apiKey: string,
  chunks: readonly Uint8Array[],
  sampleRateHz: number,
): Promise<string> {
  const repoRoot = resolve(SCRIPT_DIR, "../../..");
  const genaiPath = require.resolve("@google/genai", {
    paths: [resolve(repoRoot, "packages/realtime")],
  });
  const { GoogleGenAI } = await import(genaiPath);

  const bytes = mergeBytes(chunks);
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const wav = new WaveFile();
  wav.fromScratch(1, sampleRateHz, "16", samples);
  const wavBase64 = Buffer.from(wav.toBuffer()).toString("base64");

  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [{
      parts: [
        { inlineData: { mimeType: "audio/wav", data: wavBase64 } },
        { text: "Transcribe the spoken audio. The audio should be Spanish. Reply with only the transcript in the language actually spoken." },
      ],
    }],
  });
  return response.text?.trim() ?? "";
}

function looksLikeSpanish(text: string): boolean {
  const lower = text.toLowerCase();
  const spanishMarkers = [
    "fecha", "plazo", "informática", "informatica", "ciencias de la computación",
    "computación", "computacion", "maestría", "maestria", "universidad", "solicitud",
    "marzo", "límite", "limite", "postulación", "postulacion", "¿cuál", "cual es",
  ];
  if (spanishMarkers.some((m) => lower.includes(m))) return true;
  if (/[áéíóúñ¿¡]/.test(lower)) return true;
  const englishMarkers = ["application deadline", "computer science", "masters", "what's the", "what is the"];
  return englishMarkers.every((m) => !lower.includes(m));
}

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  const apiKey = process.env["GEMINI_API_KEY"]?.trim();
  if (!apiKey) throw new Error("missing GEMINI_API_KEY in repo-root .env");

  await mkdir(OUTPUT_DIR, { recursive: true });

  const timeline: TimelineEntry[] = [];
  const startedAt = Date.now();
  const pushTimeline = (event: string, detail?: string): void => {
    timeline.push({ atMs: Date.now() - startedAt, event, detail });
  };

  const outputChunks: Uint8Array[] = [];
  let inputTranscript = "";
  let outputTranscript = "";
  let sawOutputAudio = false;
  let sessionError: Error | null = null;

  const translateSession = await createGeminiTranslateSession({
    apiKey,
    targetLanguageCode: TARGET_LANGUAGE,
    echoTargetLanguage: true,
    onAudio: (pcm16, rate) => {
      if (!sawOutputAudio) {
        sawOutputAudio = true;
        pushTimeline("translate.audio.first", String(rate));
      }
      outputChunks.push(pcm16);
    },
    onText: (text, role, final) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (role === "input") {
        inputTranscript = mergeTranscript(inputTranscript, trimmed);
        pushTimeline(final ? "translate.input_transcript.final" : "translate.input_transcript", trimmed);
      } else {
        outputTranscript = mergeTranscript(outputTranscript, trimmed);
        pushTimeline(final ? "translate.output_transcript.final" : "translate.output_transcript", trimmed);
      }
    },
    onError: (cause) => {
      sessionError = cause;
      pushTimeline("translate.error", cause.message);
    },
  });

  const pcm = readPcm16Mono16kWav(FIXTURE_PATH);
  let offset = 0;
  while (offset < pcm.length) {
    const frame = sliceFramePcm(pcm, offset);
    translateSession.sendAudio(pcmToBytes(frame));
    offset += FRAME_SAMPLES;
    await sleep(20);
  }

  for (let pad = 0; pad < 100; pad += 1) {
    translateSession.sendAudio(pcmToBytes(new Int16Array(FRAME_SAMPLES)));
    await sleep(20);
  }

  translateSession.signalAudioStreamEnd();
  pushTimeline("input.audio.stream_end");
  await sleep(20_000);

  await translateSession.close();

  if (sessionError) throw sessionError;
  if (!isNonSilentAudio(outputChunks)) {
    console.error(JSON.stringify({ timeline, audioBytes: mergeBytes(outputChunks).byteLength }, null, 2));
    throw new Error("translated audio is silent");
  }
  let verifiedTranscript = outputTranscript.trim();
  if (!verifiedTranscript) {
    pushTimeline("translate.output_transcript.missing_live", "falling back to generateContent STT");
    verifiedTranscript = await transcribeOutputAudio(apiKey, outputChunks, OUTPUT_SAMPLE_RATE_HZ);
    pushTimeline("translate.output_transcript.stt_fallback", verifiedTranscript);
  }

  const expectedSpanish = await expectedSpanishReference(apiKey, inputTranscript);
  pushTimeline("translate.expected_spanish_reference", expectedSpanish);

  const spanishByText = verifiedTranscript ? looksLikeSpanish(verifiedTranscript) : false;
  const spanishBySemantics = await verifyAudioMatchesSpanish(
    apiKey,
    outputChunks,
    OUTPUT_SAMPLE_RATE_HZ,
    expectedSpanish,
  );
  pushTimeline("translate.semantic_verify", String(spanishBySemantics));

  if (!spanishByText && !spanishBySemantics) {
    throw new Error(
      `translation not verified Spanish: transcript="${verifiedTranscript}" expected="${expectedSpanish}" semantic=${spanishBySemantics}`,
    );
  }

  const outPath = join(OUTPUT_DIR, "translated-es.wav");
  await writePcm16Wav(outPath, outputChunks, OUTPUT_SAMPLE_RATE_HZ);

  const pass = isNonSilentAudio(outputChunks) && (spanishByText || spanishBySemantics);

  console.log(`\n=== GEMINI TRANSLATE PASS: ${pass ? "YES" : "NO"} ===`);
  console.log(`model: ${GEMINI_TRANSLATE_MODEL}`);
  console.log(`target language: ${TARGET_LANGUAGE}`);
  console.log(`input transcript: ${inputTranscript}`);
  console.log(`output transcript (live): ${outputTranscript}`);
  console.log(`output transcript (verified): ${verifiedTranscript}`);
  console.log(`expected Spanish reference: ${expectedSpanish}`);
  console.log(`semantic match: ${spanishBySemantics}`);
  console.log(`audio out: ${outPath} (${mergeBytes(outputChunks).byteLength} bytes)`);

  console.log(JSON.stringify({
    ok: pass,
    model: GEMINI_TRANSLATE_MODEL,
    targetLanguageCode: TARGET_LANGUAGE,
    inputTranscript,
    outputTranscript,
    verifiedTranscript,
    expectedSpanish,
    spanishBySemantics,
    outPath,
    timeline,
  }, null, 2));

  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
