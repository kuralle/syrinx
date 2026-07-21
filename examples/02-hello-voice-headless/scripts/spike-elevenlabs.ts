// SPDX-License-Identifier: MIT
//
// SPIKE: prove the new ElevenLabs TTS (multi-context WS) + STT (Scribe v2 realtime WS) against the
// LIVE API — the new-vendor protocol was grounded in docs, so this confirms the real WS accepts the
// frames and returns audio/transcripts, plus usage.recorded on both stages.
//
// Usage: pnpm -C examples/02-hello-voice-headless exec tsx scripts/spike-elevenlabs.ts
// Requires ELEVENLABS_API_KEY in the repo .env.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PipelineBusImpl, Route, type UsageRecordedPacket, type SttResultPacket, type TextToSpeechAudioPacket } from "@kuralle-syrinx/core";
import { ElevenLabsTTSPlugin, ElevenLabsSTTPlugin } from "@kuralle-syrinx/elevenlabs";
import { createNodeWsSocket } from "@kuralle-syrinx/ws/node";

import { ensureRepoRootDotenv, readPcm16Mono16kWav } from "../src/run-one-turn.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(SCRIPT_DIR, "..", "test", "fixtures", "university-support-add-drop.wav");
const FRAME_SAMPLES = 320;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  const apiKey = process.env["ELEVENLABS_API_KEY"]?.trim();
  if (!apiKey) throw new Error("missing ELEVENLABS_API_KEY in repo-root .env");

  const usage: UsageRecordedPacket[] = [];
  const bus = new PipelineBusImpl();
  const started = bus.start();
  let ttsAudioBytes = 0;
  const finals: SttResultPacket[] = [];
  bus.on("usage.recorded", (pkt) => { usage.push(pkt as UsageRecordedPacket); });
  bus.on("tts.audio", (pkt) => { ttsAudioBytes += (pkt as TextToSpeechAudioPacket).audio.byteLength; });
  bus.on("stt.result", (pkt) => { finals.push(pkt as SttResultPacket); });
  bus.on("stt.error", (pkt) => console.log(`  stt.error ${String((pkt as unknown as { cause: Error }).cause.message)}`));
  bus.on("tts.error", (pkt) => console.log(`  tts.error ${String((pkt as unknown as { cause: Error }).cause.message)}`));

  // ---- TTS ----
  const tts = new ElevenLabsTTSPlugin(createNodeWsSocket);
  await tts.initialize(bus, { api_key: apiKey, sample_rate: 16000 });
  const ttsCtx = "el-tts";
  const text = "The application deadline is May first.";
  bus.push(Route.Main, { kind: "tts.text", contextId: ttsCtx, timestampMs: Date.now(), text });
  bus.push(Route.Main, { kind: "tts.done", contextId: ttsCtx, timestampMs: Date.now(), text });
  const ttsDeadline = Date.now() + 30_000;
  while ((ttsAudioBytes === 0 || !usage.some((u) => u.stage === "tts")) && Date.now() < ttsDeadline) await sleep(150);
  await tts.close();

  // ---- STT ----
  const stt = new ElevenLabsSTTPlugin(createNodeWsSocket);
  await stt.initialize(bus, { api_key: apiKey, sample_rate: 16000, language: "en" });
  const pcm = readPcm16Mono16kWav(FIXTURE);
  const sttCtx = "el-stt";
  for (let offset = 0; offset < pcm.length; offset += FRAME_SAMPLES) {
    const end = Math.min(offset + FRAME_SAMPLES, pcm.length);
    const frame = new Int16Array(FRAME_SAMPLES);
    frame.set(pcm.subarray(offset, end));
    bus.push(Route.Main, { kind: "stt.audio", contextId: sttCtx, timestampMs: Date.now(), audio: new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength) });
    await sleep(20);
  }
  bus.push(Route.Main, { kind: "stt.finalize", contextId: sttCtx, timestampMs: Date.now() });
  const sttDeadline = Date.now() + 30_000;
  while ((finals.length === 0 || !usage.some((u) => u.stage === "stt")) && Date.now() < sttDeadline) await sleep(150);
  await stt.close();

  bus.stop();
  await started;

  const ttsUsage = usage.find((u) => u.stage === "tts");
  const sttUsage = usage.find((u) => u.stage === "stt");
  console.log("\n===== SPIKE RESULT =====");
  console.log(`TTS: audio bytes=${ttsAudioBytes}  usage=${ttsUsage ? `${ttsUsage.characters} chars (${ttsUsage.provider})` : "MISSING"}`);
  console.log(`STT: final="${finals[0]?.text ?? "(none)"}"  usage=${sttUsage ? `${sttUsage.audioSeconds}s (${sttUsage.provider})` : "MISSING"}`);
  const ok = ttsAudioBytes > 0 && !!ttsUsage && finals.length > 0 && !!sttUsage;
  console.log(`\nElevenLabs live: ${ok ? "OK (TTS audio+usage, STT transcript+usage)" : "INCOMPLETE"}`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
