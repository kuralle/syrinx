// SPDX-License-Identifier: MIT
//
// The talking–thinking (responder–thinker) model: a fast realtime front does the
// talking; a background reasoner does the deep thinking. The front stays the voice
// the caller hears, and delegates real questions to the reasoner through a tool.
//
// See docs: /guides/talking-thinking
//
// Run it against a WAV fixture (needs OPENAI_API_KEY only):
//
//   pnpm -C examples/02-hello-voice-headless exec tsx src/talking-thinking.ts

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  Route,
  VoiceAgentSession,
  type TextToSpeechAudioPacket,
} from "@kuralle-syrinx/core";
import { RealtimeBridge, fromOpenAIRealtime, type RealtimeToolDef } from "@kuralle-syrinx/realtime";
import { fromStreamText } from "@kuralle-syrinx/aisdk";
import { createNodeWsSocket } from "@kuralle-syrinx/ws/node";
import { createOpenAI } from "@ai-sdk/openai";

import { ensureRepoRootDotenv, readPcm16Mono16kWav } from "./run-one-turn.js";

// The tool the front advertises. When the front decides a turn needs grounded
// knowledge, it calls this tool — and the bridge routes the query to the thinker.
const CONSULT_TOOL: RealtimeToolDef = {
  name: "consult_knowledge",
  description:
    "Look up grounded, factual answers. Call this for real questions; answer greetings and small talk directly.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "The user's question, self-contained." } },
    required: ["query"],
  },
};

export function createTalkingThinkingAgent(): VoiceAgentSession {
  const openai = createOpenAI({ apiKey: process.env["OPENAI_API_KEY"] });

  // The thinker: a deep reasoner. AI SDK here; swap for a kuralle RAG agent or Mastra.
  const thinker = fromStreamText({
    model: openai("gpt-4.1"),
    system: "Answer the user's question with grounded facts. Be concise.",
  });

  // The talker: a realtime front that advertises the consult tool.
  const front = fromOpenAIRealtime({
    apiKey: process.env["OPENAI_API_KEY"]!,
    socketFactory: createNodeWsSocket,
    tools: [CONSULT_TOOL],
  });

  const session = new VoiceAgentSession({
    plugins: { realtime: {} },
    endpointingOwner: "timer", // the realtime front owns its own turn detection
  });

  // The bridge delegates CONSULT_TOOL calls to the thinker, then feeds the answer
  // back to the front as an authoritative tool result — the front speaks it faithfully.
  session.registerPlugin("realtime", new RealtimeBridge(front, thinker, CONSULT_TOOL.name));

  // Show a "thinking…" indicator only when the background agent is actually slow.
  session.on("tool_call_cue", (cue) => {
    if (cue.phase === "delayed") console.log("thinking…");
  });

  return session;
}

// --- Running it ------------------------------------------------------------
//
// Same shape as hello-voice-agent.ts: build, `start()`, then push audio frames
// the way a transport would. The realtime front owns endpointing, so the
// trailing silence is what tells it the caller stopped talking.

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "test",
  "fixtures",
  "university-cs-masters-deadline.wav",
);
const FRAME_SAMPLES = 320; // 20ms at 16kHz
const TRAILING_SILENCE_FRAMES = 100; // 2s — the front's turn detector needs the gap
const TURN_TIMEOUT_MS = 120_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function push(session: VoiceAgentSession, frame: Int16Array, contextId: string): void {
  session.bus.push(Route.Main, {
    kind: "user.audio_received",
    contextId,
    timestampMs: Date.now(),
    audio: new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength),
  });
}

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  if (!process.env["OPENAI_API_KEY"]?.trim()) {
    console.error("Missing env key: OPENAI_API_KEY");
    process.exit(1);
  }

  const session = createTalkingThinkingAgent();
  const contextId = `talking-thinking-${String(Date.now())}`;
  let audioBytes = 0;
  let spoken = false;

  session.bus.on("tts.audio", (pkt: TextToSpeechAudioPacket) => {
    audioBytes += pkt.audio.byteLength;
  });
  session.bus.on("tts.end", () => {
    spoken = true;
  });

  await session.start();

  const samples = readPcm16Mono16kWav(FIXTURE);
  console.log(`Feeding ${(samples.length / 16_000).toFixed(1)}s of audio…\n`);
  for (let offset = 0; offset < samples.length; offset += FRAME_SAMPLES) {
    const frame = new Int16Array(FRAME_SAMPLES);
    frame.set(samples.subarray(offset, Math.min(samples.length, offset + FRAME_SAMPLES)));
    push(session, frame, contextId);
    await sleep(20);
  }
  for (let pad = 0; pad < TRAILING_SILENCE_FRAMES; pad += 1) {
    push(session, new Int16Array(FRAME_SAMPLES), contextId);
    await sleep(20);
  }

  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (!spoken && Date.now() < deadline) await sleep(100);

  console.log(`The front spoke: ${audioBytes} bytes${spoken ? "" : " (timed out)"}`);
  console.log("A 'thinking…' line above means the front delegated to the thinker.");

  await session.close();
  process.exit(spoken ? 0 : 1);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
