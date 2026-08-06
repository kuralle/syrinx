// SPDX-License-Identifier: MIT
//
// Half-cascade live proof (RFC docs/rfc-half-cascade.md, C4): one turn through
// VoiceAgentSession with a TEXT-ONLY realtime front (gpt-realtime) + Syrinx's own
// TTS (Cartesia). The provider does native speech comprehension + server-VAD turn
// detection but emits NO audio (modalities:["text"]); its text streams
// llm.delta -> session segmenter -> tts.text -> Cartesia -> tts.audio (OUR audio).
// Asserts: audio is non-silent AND produced by Cartesia (structural faithful voicing,
// REQ-4). Reports v2v TTFA (first Syrinx tts.audio after the user turn ends).

import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Route, VoiceAgentSession, type TextToSpeechAudioPacket, type TextToSpeechEndPacket } from "@kuralle-syrinx/core";
import { RealtimeBridge, fromOpenAIRealtime } from "@kuralle-syrinx/realtime";
import { CartesiaTTSPlugin } from "@kuralle-syrinx/cartesia";
import { createNodeWsSocket } from "@kuralle-syrinx/ws/node";

import { ensureRepoRootDotenv, readPcm16Mono16kWav } from "../src/run-one-turn.js";

const require = createRequire(import.meta.url);
const { WaveFile } = require("wavefile") as typeof import("wavefile");

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const FIXTURE_PATH = join(PKG_ROOT, "test", "fixtures", "university-support-add-drop.wav");
const OUTPUT_DIR = join(PKG_ROOT, "test", "performance", "runs", "half-cascade-oneturn");
const INPUT_SAMPLE_RATE_HZ = 16_000;
const FRAME_SAMPLES = 320;

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
  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.byteLength; }
  return merged;
}
function isNonSilent(chunks: readonly Uint8Array[]): boolean {
  const bytes = mergeBytes(chunks);
  if (bytes.byteLength < 4) return false;
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  return peak > 100;
}
function writeWav(path: string, chunks: readonly Uint8Array[], rate: number): Promise<void> {
  const bytes = mergeBytes(chunks);
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const wav = new WaveFile();
  wav.fromScratch(1, rate, "16", samples);
  return writeFile(path, Buffer.from(wav.toBuffer()));
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  const apiKey = process.env["OPENAI_API_KEY"]?.trim();
  const cartesiaKey = process.env["CARTESIA_API_KEY"]?.trim();
  if (!apiKey) throw new Error("missing OPENAI_API_KEY in repo-root .env");
  if (!cartesiaKey) throw new Error("missing CARTESIA_API_KEY in repo-root .env");
  await mkdir(OUTPUT_DIR, { recursive: true });

  const pcm = readPcm16Mono16kWav(FIXTURE_PATH);

  // TEXT-ONLY front: modalities:["text"] => provider comprehends + VADs, emits NO audio.
  const adapter = fromOpenAIRealtime({
    apiKey,
    socketFactory: createNodeWsSocket,
    modalities: ["text"],
    turnDetection: { type: "server_vad", silence_duration_ms: 500 },
  });
  const bridge = new RealtimeBridge(adapter, undefined, undefined, { textOnly: true });

  const session = new VoiceAgentSession({
    plugins: { realtime: {}, cartesia: { api_key: cartesiaKey, sample_rate: INPUT_SAMPLE_RATE_HZ } },
    endpointingOwner: "timer",
  });
  session.registerPlugin("realtime", bridge);
  session.registerPlugin("cartesia", new CartesiaTTSPlugin());

  const outputChunks: Uint8Array[] = [];
  const providers = new Set<string>();
  let responseContextId = "";
  let firstAudioMs = 0;
  let userTurnEndMs = 0;

  const offAudio = session.bus.on<TextToSpeechAudioPacket>("tts.audio", (pkt) => {
    if (!responseContextId) responseContextId = pkt.contextId;
    if (pkt.contextId !== responseContextId) return;
    if (firstAudioMs === 0) firstAudioMs = Date.now();
    if (pkt.provider?.["name"]) providers.add(String(pkt.provider["name"]));
    outputChunks.push(pkt.audio);
  });
  const ttsEnd = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { off(); reject(new Error("tts.end timeout (120s)")); }, 120_000);
    const off = session.bus.on<TextToSpeechEndPacket>("tts.end", (pkt) => {
      if (responseContextId && pkt.contextId !== responseContextId) return;
      clearTimeout(timeout); off(); resolve();
    });
  });

  await session.start();
  const transportContextId = crypto.randomUUID();
  let offset = 0;
  while (offset < pcm.length) {
    session.bus.push(Route.Media, { kind: "user.audio_received", contextId: transportContextId, timestampMs: Date.now(), audio: pcmToBytes(sliceFramePcm(pcm, offset)) });
    offset += FRAME_SAMPLES;
    await sleep(20);
  }
  userTurnEndMs = Date.now();
  for (let pad = 0; pad < 100; pad += 1) {
    session.bus.push(Route.Media, { kind: "user.audio_received", contextId: transportContextId, timestampMs: Date.now(), audio: pcmToBytes(new Int16Array(FRAME_SAMPLES)) });
    await sleep(20);
  }

  await ttsEnd;
  offAudio();

  const nonSilent = isNonSilent(outputChunks);
  const bySyrinxTts = providers.has("cartesia") && !providers.has("openai");
  const ttfaMs = firstAudioMs > 0 ? firstAudioMs - userTurnEndMs : -1;
  const outPath = join(OUTPUT_DIR, "audio-out.wav");
  await writeWav(outPath, outputChunks, INPUT_SAMPLE_RATE_HZ);

  const result = { ok: nonSilent && bySyrinxTts, mode: "half-cascade", front: "gpt-realtime (text-only)", tts: [...providers], v2v_ttfa_ms: ttfaMs, audioBytes: mergeBytes(outputChunks).byteLength, nonSilent, bySyrinxTts, outPath };
  console.log(JSON.stringify(result));

  await session.close();
  await adapter.close();
  if (!result.ok) process.exit(1);
  process.exit(0);
}

main().catch((err: unknown) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
