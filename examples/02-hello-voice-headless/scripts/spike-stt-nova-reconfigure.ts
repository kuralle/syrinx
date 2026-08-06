// SPDX-License-Identifier: MIT
//
// SPIKE: prove Deepgram Nova mid-session reconfigure works against the LIVE API.
// Opens a Nova socket, streams a fixture, calls nova.reconfigure() mid-stream
// (new keyterms + tighter endpointingMs), then asserts reconnect took effect via
// the existing stt.deepgram.reconnect_replay_* metric (or continued recognition).
// Nova has no in-band Configure — reconfigure = reconnect with rebuilt URL params.
//
// Usage: pnpm -C examples/02-hello-voice-headless exec tsx scripts/spike-stt-nova-reconfigure.ts
// Requires DEEPGRAM_API_KEY in the repo .env. ~$0.001 of Nova streaming, zero LLM credits.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { PipelineBusImpl, Route, type ConversationMetricPacket } from "@kuralle-syrinx/core";
import { DeepgramSTTPlugin } from "@kuralle-syrinx/deepgram";

loadEnv({ path: resolve(import.meta.dirname, "../../../.env") });

const apiKey = process.env["DEEPGRAM_API_KEY"];
if (!apiKey) {
  console.error("DEEPGRAM_API_KEY missing");
  process.exit(1);
}

const FIXTURE = resolve(import.meta.dirname, "../test/fixtures/university-cs-masters-deadline.wav");
const CHUNK_BYTES = 2560; // 80 ms @ 16 kHz PCM16
const CHUNK_MS = 80;

async function main(): Promise<void> {
  const startedAt = Date.now();
  const t = (): string => `+${String(Date.now() - startedAt).padStart(5)}ms`;

  const bus = new PipelineBusImpl();
  const drain = bus.start();

  let reconnectReplay = false;
  let interimAfterReconfigure = false;
  let reconfigured = false;
  const metrics: string[] = [];

  bus.on("metric.conversation", (pkt) => {
    const m = pkt as ConversationMetricPacket;
    metrics.push(m.name);
    if (m.name.startsWith("stt.deepgram.reconnect_replay_")) {
      reconnectReplay = true;
      console.log(`${t()} RECONNECT_REPLAY  ${m.name}=${m.value}`);
    }
    if (m.name === "stt_provider_reconnect_discarded_state") {
      reconnectReplay = true;
      console.log(`${t()} RECONNECT_DISCARD ${m.value}`);
    }
  });
  bus.on("stt.interim", (pkt) => {
    if (reconfigured) {
      interimAfterReconfigure = true;
      console.log(`${t()} stt.interim        ${String((pkt as unknown as { text: string }).text).slice(0, 60)}`);
    }
  });
  bus.on("stt.result", (pkt) => {
    if (reconfigured) {
      interimAfterReconfigure = true;
      console.log(`${t()} stt.result         ${String((pkt as unknown as { text: string }).text).slice(0, 60)}`);
    }
  });
  bus.on("stt.error", (pkt) => {
    console.log(`${t()} stt.error          ${String((pkt as unknown as { cause: Error }).cause.message)}`);
  });

  const nova = new DeepgramSTTPlugin();
  await nova.initialize(bus, {
    api_key: apiKey,
    sample_rate: 16000,
    model: "nova-3",
    keyterm: ["Syrinx"],
    endpointing: 300,
    interim_results: true,
  });
  console.log(`${t()} connected          nova-3, keyterm=[Syrinx], endpointing=300`);

  const pcm = readFileSync(FIXTURE).subarray(44); // strip WAV header
  const reconfigureAtChunk = 6; // ~480ms in — mid-stream, socket is live
  let chunk = 0;
  for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
    bus.push(Route.Media, {
      kind: "stt.audio",
      contextId: "nova-spike-1",
      timestampMs: Date.now(),
      audio: new Uint8Array(pcm.subarray(offset, offset + CHUNK_BYTES)),
    });
    chunk += 1;
    if (chunk === reconfigureAtChunk) {
      console.log(`${t()} RECONFIGURE →      keyterms=[account number, Syrinx], endpointingMs=120, language=multi`);
      nova.reconfigure({
        keyterms: ["account number", "Syrinx"],
        endpointingMs: 120,
        language: "multi", // hard language switch (Nova-3 code-switch) — applied on reconnect
      });
      reconfigured = true;
    }
    await new Promise((r) => setTimeout(r, CHUNK_MS));
  }

  // Let reconnect + post-reconnect recognition settle.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !(reconnectReplay || interimAfterReconfigure)) {
    await new Promise((r) => setTimeout(r, 100));
  }

  await nova.close();
  bus.stop();
  await drain;

  const ok = reconnectReplay || interimAfterReconfigure;
  console.log("\n===== SPIKE RESULT =====");
  console.log(`reconnect observed (metric): ${reconnectReplay ? "YES" : "NO"}`);
  console.log(`recognition after reconfigure: ${interimAfterReconfigure ? "YES" : "NO"}`);
  console.log(`metrics seen: ${metrics.filter((n) => n.includes("reconnect") || n.includes("deepgram")).join(", ") || "(none)"}`);
  console.log(`mid-session reconfigure took effect: ${ok ? "YES" : "NO"}`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
