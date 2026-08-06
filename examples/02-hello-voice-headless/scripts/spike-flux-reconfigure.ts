// SPDX-License-Identifier: MIT
//
// SPIKE: prove Deepgram Flux v2 mid-stream reconfigure works against the LIVE API.
// Opens a Flux socket, streams a fixture, and calls flux.reconfigure() mid-stream
// (new keyterms + tighter eot_threshold), then asserts the provider acks with
// ConfigureSuccess (surfaced as the stt.flux.configure_success metric). This is the
// empirical gate for Slice E-a's no-restart reconfigure path.
//
// Usage: pnpm -C examples/02-hello-voice-headless exec tsx scripts/spike-flux-reconfigure.ts
// Requires DEEPGRAM_API_KEY in the repo .env. ~$0.001 of Flux streaming, zero LLM credits.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { PipelineBusImpl, Route, type ConversationMetricPacket } from "@kuralle-syrinx/core";
import { DeepgramFluxSTTPlugin } from "@kuralle-syrinx/deepgram";

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

  let configureSuccess = false;
  let configureFailure: string | null = null;
  bus.on("metric.conversation", (pkt) => {
    const m = pkt as ConversationMetricPacket;
    if (m.name === "stt.flux.configure_success") {
      configureSuccess = true;
      console.log(`${t()} CONFIGURE_SUCCESS  provider acked the mid-stream Configure`);
    }
    if (m.name === "stt.flux.configure_failure") {
      configureFailure = m.value;
      console.log(`${t()} CONFIGURE_FAILURE  ${m.value}`);
    }
  });
  bus.on("stt.error", (pkt) => {
    console.log(`${t()} stt.error          ${String((pkt as unknown as { cause: Error }).cause.message)}`);
  });

  const flux = new DeepgramFluxSTTPlugin();
  await flux.initialize(bus, {
    api_key: apiKey,
    sample_rate: 16000,
    eot_threshold: 0.7,
    eager_eot_threshold: 0.4,
    keyterm: ["Syrinx"],
  });
  console.log(`${t()} connected          flux-general-en, keyterm=[Syrinx], eot_threshold=0.7`);

  const pcm = readFileSync(FIXTURE).subarray(44); // strip WAV header
  const reconfigureAtChunk = 6; // ~480ms in — mid-stream, socket is live
  let chunk = 0;
  for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
    bus.push(Route.Media, {
      kind: "stt.audio",
      contextId: "flux-spike-1",
      timestampMs: Date.now(),
      audio: new Uint8Array(pcm.subarray(offset, offset + CHUNK_BYTES)),
    });
    chunk += 1;
    if (chunk === reconfigureAtChunk) {
      console.log(`${t()} RECONFIGURE →      keyterms=[account number, Syrinx], eot_threshold=0.85, eot_timeout_ms=3000`);
      flux.reconfigure({
        keyterms: ["account number", "Syrinx"],
        eotThreshold: 0.85,
        eotTimeoutMs: 3000,
      });
    }
    await new Promise((r) => setTimeout(r, CHUNK_MS));
  }

  // Let the ack land.
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && !configureSuccess && !configureFailure) {
    await new Promise((r) => setTimeout(r, 100));
  }

  await flux.close();
  bus.stop();
  await drain;

  console.log("\n===== SPIKE RESULT =====");
  console.log(`mid-stream reconfigure acked live: ${configureSuccess ? "YES (ConfigureSuccess)" : configureFailure ? `NO (ConfigureFailure: ${configureFailure})` : "NO ACK RECEIVED"}`);
  process.exit(configureSuccess ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
