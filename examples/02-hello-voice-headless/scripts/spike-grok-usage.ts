// SPDX-License-Identifier: MIT
//
// SPIKE: prove the new Grok STT + TTS usage.recorded producers fire against the LIVE xAI API.
// The Nova lesson: unit tests can pass while the live emit point never fires. This exercises
// real Grok STT (final transcript → stage:stt audioSeconds) and real Grok TTS (synthesis →
// stage:tts characters) and asserts both usage packets appear.
//
// Usage: pnpm -C examples/02-hello-voice-headless exec tsx scripts/spike-grok-usage.ts
// Requires XAI_API_KEY in the repo .env.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PipelineBusImpl, Route, type UsageRecordedPacket } from "@kuralle-syrinx/core";
import { GrokSTTPlugin } from "@kuralle-syrinx/grok/stt";
import { GrokTTSPlugin } from "@kuralle-syrinx/grok/tts";
import { createNodeWsSocket } from "@kuralle-syrinx/ws/node";

import { ensureRepoRootDotenv, readPcm16Mono16kWav } from "../src/run-one-turn.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(SCRIPT_DIR, "..", "test", "fixtures", "university-support-add-drop.wav");
const FRAME_SAMPLES = 320;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  const apiKey = process.env["XAI_API_KEY"]?.trim();
  if (!apiKey) throw new Error("missing XAI_API_KEY in repo-root .env");

  const usage: UsageRecordedPacket[] = [];
  const bus = new PipelineBusImpl();
  const started = bus.start();
  bus.on("usage.recorded", (pkt) => {
    const u = pkt as UsageRecordedPacket;
    usage.push(u);
    console.log(`  usage.recorded  stage=${u.stage} provider=${u.provider} model=${u.model} ` +
      `audioSeconds=${u.audioSeconds ?? "-"} characters=${u.characters ?? "-"}`);
  });

  // ---- Grok STT ----
  const stt = new GrokSTTPlugin(createNodeWsSocket);
  await stt.initialize(bus, { api_key: apiKey, language: "en", sample_rate: 16000, emit_eos_on_final: true });
  const pcm = readPcm16Mono16kWav(FIXTURE_PATH);
  const sttCtx = "grok-usage-stt";
  for (let offset = 0; offset < pcm.length; offset += FRAME_SAMPLES) {
    const end = Math.min(offset + FRAME_SAMPLES, pcm.length);
    const frame = new Int16Array(FRAME_SAMPLES);
    frame.set(pcm.subarray(offset, end));
    bus.push(Route.Media, {
      kind: "stt.audio",
      contextId: sttCtx,
      timestampMs: Date.now(),
      audio: new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength),
    });
    await sleep(20);
  }
  bus.push(Route.Main, { kind: "stt.finalize", contextId: sttCtx, timestampMs: Date.now() });
  const sttDeadline = Date.now() + 30_000;
  while (!usage.some((u) => u.stage === "stt") && Date.now() < sttDeadline) await sleep(100);
  await stt.close();

  // ---- Grok TTS ----
  const tts = new GrokTTSPlugin(createNodeWsSocket);
  await tts.initialize(bus, { api_key: apiKey });
  const ttsCtx = "grok-usage-tts";
  const text = "The application deadline is May first.";
  bus.push(Route.Main, { kind: "tts.text", contextId: ttsCtx, timestampMs: Date.now(), text });
  bus.push(Route.Main, { kind: "tts.done", contextId: ttsCtx, timestampMs: Date.now(), text });
  const ttsDeadline = Date.now() + 30_000;
  while (!usage.some((u) => u.stage === "tts") && Date.now() < ttsDeadline) await sleep(100);
  await tts.close();

  bus.stop();
  await started;

  const sttUsage = usage.find((u) => u.stage === "stt");
  const ttsUsage = usage.find((u) => u.stage === "tts");
  console.log("\n===== SPIKE RESULT =====");
  console.log(`Grok STT usage.recorded (audioSeconds): ${sttUsage ? `YES (${sttUsage.audioSeconds}s, ${sttUsage.provider})` : "MISSING"}`);
  console.log(`Grok TTS usage.recorded (characters):   ${ttsUsage ? `YES (${ttsUsage.characters} chars, ${ttsUsage.provider})` : "MISSING"}`);
  process.exit(sttUsage && ttsUsage ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
