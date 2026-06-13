// SPDX-License-Identifier: MIT
//
// Minimal Epsilon TTS usage example (not wired into a full voice session).

import { PipelineBusImpl, Route } from "@kuralle-syrinx/core";
import { EpsilonTTSPlugin } from "@kuralle-syrinx/epsilon";

const EPSILON_BASE_URL = process.env["EPSILON_BASE_URL"];
const EPSILON_API_KEY = process.env["EPSILON_API_KEY"];

async function main(): Promise<void> {
  if (!EPSILON_BASE_URL || !EPSILON_API_KEY) {
    throw new Error("Set EPSILON_BASE_URL and EPSILON_API_KEY in the environment to run this example.");
  }
  const bus = new PipelineBusImpl();
  const started = bus.start();
  const plugin = new EpsilonTTSPlugin();

  let pcmBytes = 0;
  bus.on("tts.audio", (pkt) => {
    const audioPkt = pkt as { audio: Uint8Array };
    pcmBytes += audioPkt.audio.byteLength;
  });
  bus.on("tts.end", () => {
    console.log(`epsilon tts end (${String(pcmBytes)} pcm bytes)`);
  });

  await plugin.initialize(bus, {
    api_key: EPSILON_API_KEY,
    base_url: EPSILON_BASE_URL,
    voice: "sinhala",
    sample_rate: 24000,
  });

  bus.push(Route.Main, {
    kind: "tts.text",
    contextId: "example-turn",
    timestampMs: Date.now(),
    text: "හරි, මම බලන්නම්.",
  });
  bus.push(Route.Main, {
    kind: "tts.done",
    contextId: "example-turn",
    timestampMs: Date.now(),
    text: "හරි, මම බලන්නම්.",
  });

  await new Promise((resolve) => setTimeout(resolve, 120_000));
  await plugin.close();
  bus.stop();
  await started;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
