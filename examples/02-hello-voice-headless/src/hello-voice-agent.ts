// SPDX-License-Identifier: MIT
//
// Minimal cascade voice agent — the runnable version of the "Building a voice agent"
// docs guide. Deepgram STT -> an AI SDK reasoner -> Cartesia TTS, with Deepgram
// owning endpointing. See docs: /guides/building-a-voice-agent
//
// Run it against a WAV fixture (no mic, no transport, no server):
//
//   pnpm -C examples/02-hello-voice-headless exec tsx src/hello-voice-agent.ts

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  Route,
  VoiceAgentSession,
  type LlmDeltaPacket,
  type SttResultPacket,
  type TextToSpeechAudioPacket,
  type VoicePlugin,
} from "@kuralle-syrinx/core";
import { DeepgramSTTPlugin } from "@kuralle-syrinx/deepgram";
import { CartesiaTTSPlugin } from "@kuralle-syrinx/cartesia";
import { ReasoningBridge, fromStreamText } from "@kuralle-syrinx/aisdk";
import { createOpenAI } from "@ai-sdk/openai";

import {
  ensureRepoRootDotenv,
  listMissingVoiceHeadlessEnvKeys,
  readPcm16Mono16kWav,
} from "./run-one-turn.js";

export function createHelloVoiceAgent(): VoiceAgentSession {
  const openai = createOpenAI({ apiKey: process.env["OPENAI_API_KEY"] });

  // Per-slot config (API keys, model, voice) goes in the constructor.
  const session = new VoiceAgentSession({
    plugins: {
      stt: {
        api_key: process.env["DEEPGRAM_API_KEY"] ?? "",
        model: "nova-3",
        sample_rate: 16000,
        emit_eos_on_final: true,
      },
      bridge: {},
      tts: {
        api_key: process.env["CARTESIA_API_KEY"] ?? "",
        voice_id: process.env["CARTESIA_VOICE_ID"] ?? "",
      },
    },
    endpointingOwner: "provider_stt",
  });

  // The plugin instances are registered by slot: stt, the reasoner bridge, and tts.
  const plugins: Record<string, VoicePlugin> = {
    stt: new DeepgramSTTPlugin(),
    bridge: new ReasoningBridge(
      fromStreamText({
        model: openai("gpt-4.1-mini"),
        system: "You are a helpful voice assistant. Keep your replies short.",
      }),
    ),
    tts: new CartesiaTTSPlugin(),
  };
  for (const [name, plugin] of Object.entries(plugins)) {
    session.registerPlugin(name, plugin);
  }

  return session;
}

// --- Running it ------------------------------------------------------------
//
// The session above is only *built*. Nothing happens until `start()` runs the
// plugin init chain and starts draining the bus, and nothing reaches the STT
// until a transport pushes audio frames. In production the transport is a
// browser socket or a phone call; here it is a WAV file, which is what makes
// this runnable on your laptop with no server.

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "test",
  "fixtures",
  "university-cs-masters-deadline.wav",
);
const FRAME_SAMPLES = 320; // 20ms at 16kHz
const TRAILING_SILENCE_MS = 1500; // lets the endpointer close the turn
const TURN_TIMEOUT_MS = 60_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Push 20ms PCM frames the way a real transport would. */
async function feed(session: VoiceAgentSession, samples: Int16Array, contextId: string): Promise<void> {
  for (let offset = 0; offset < samples.length; offset += FRAME_SAMPLES) {
    const frame = new Int16Array(FRAME_SAMPLES);
    frame.set(samples.subarray(offset, Math.min(samples.length, offset + FRAME_SAMPLES)));
    session.bus.push(Route.Media, {
      kind: "user.audio_received",
      contextId,
      timestampMs: Date.now(),
      audio: new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength),
    });
    await sleep(20); // real-time pacing — the endpointer reads wall-clock gaps
  }
}

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  const missing = listMissingVoiceHeadlessEnvKeys();
  if (missing.length > 0) {
    console.error(`Missing env keys: ${missing.join(", ")}`);
    console.error("Set them in the repo-root .env, then re-run.");
    process.exit(1);
  }

  const session = createHelloVoiceAgent();
  const contextId = `hello-${String(Date.now())}`;
  let transcript = "";
  let reply = "";
  let audioBytes = 0;
  let spoken = false;

  session.bus.on("stt.result", (pkt: SttResultPacket) => {
    transcript = pkt.text;
  });
  session.bus.on("llm.delta", (pkt: LlmDeltaPacket) => {
    reply += pkt.text;
  });
  session.bus.on("tts.audio", (pkt: TextToSpeechAudioPacket) => {
    audioBytes += pkt.audio.byteLength;
  });
  session.bus.on("tts.end", () => {
    spoken = true;
  });

  // THE line the docs used to omit: without it no plugin is initialized and the
  // bus never drains, so audio pushed below would go nowhere.
  await session.start();

  const samples = readPcm16Mono16kWav(FIXTURE);
  console.log(`Feeding ${(samples.length / 16_000).toFixed(1)}s of audio…\n`);
  await feed(session, samples, contextId);
  await feed(session, new Int16Array((16_000 * TRAILING_SILENCE_MS) / 1000), contextId);

  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (!spoken && Date.now() < deadline) await sleep(100);

  console.log(`You said:   ${transcript || "(no transcript)"}`);
  console.log(`Agent said: ${reply || "(no reply)"}`);
  console.log(`Spoken:     ${audioBytes} bytes of TTS audio${spoken ? "" : " (timed out)"}`);

  await session.close();
  if (!spoken) process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
