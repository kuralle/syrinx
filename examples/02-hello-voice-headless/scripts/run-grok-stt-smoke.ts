// SPDX-License-Identifier: MIT

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PipelineBusImpl, Route, type SttResultPacket } from "@kuralle-syrinx/core";
import { GrokSTTPlugin } from "@kuralle-syrinx/grok/stt";
import { createNodeWsSocket } from "@kuralle-syrinx/ws/node";

import { ensureRepoRootDotenv, readPcm16Mono16kWav } from "../src/run-one-turn.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const FIXTURE_PATH = join(PKG_ROOT, "test", "fixtures", "university-support-add-drop.wav");
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  const apiKey = process.env["XAI_API_KEY"]?.trim();
  if (!apiKey) throw new Error("missing XAI_API_KEY in repo-root .env");

  const pcm = readPcm16Mono16kWav(FIXTURE_PATH);
  const bus = new PipelineBusImpl();
  const started = bus.start();
  const plugin = new GrokSTTPlugin(createNodeWsSocket);

  const finals: SttResultPacket[] = [];
  bus.on("stt.result", (pkt) => {
    finals.push(pkt as SttResultPacket);
  });

  await plugin.initialize(bus, {
    api_key: apiKey,
    language: "en",
    sample_rate: 16000,
    emit_eos_on_final: true,
  });

  const contextId = crypto.randomUUID();
  let offset = 0;
  while (offset < pcm.length) {
    bus.push(Route.Main, {
      kind: "stt.audio",
      contextId,
      timestampMs: Date.now(),
      audio: pcmToBytes(sliceFramePcm(pcm, offset)),
    });
    offset += FRAME_SAMPLES;
    await sleep(20);
  }

  bus.push(Route.Main, { kind: "stt.finalize", contextId, timestampMs: Date.now() });

  const deadline = Date.now() + 60_000;
  while (finals.length === 0 && Date.now() < deadline) {
    await sleep(100);
  }

  const transcript = finals.map((f) => f.text).join(" ").trim();
  if (transcript.length === 0) {
    throw new Error("Grok STT smoke produced no transcript");
  }

  console.log(JSON.stringify({ ok: true, contextId, transcript, segments: finals.length }));

  await plugin.close();
  bus.stop();
  await started;
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
