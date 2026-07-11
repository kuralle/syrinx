// SPDX-License-Identifier: MIT
//
// Half-cascade MULTI-TURN conversation (RFC docs/rfc-half-cascade.md): a full end-to-end call you
// can listen to. Three user turns (real fixtures) through the text-only realtime front + Syrinx TTS
// (Cartesia). The recorder writes a stereo conversation.wav — your INPUT on one channel, the
// assistant OUTPUT on the other — so it plays back like a real call. The third fixture
// ("what did I just ask") exercises multi-turn context (same realtime session across turns).

import { mkdir, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Route, VoiceAgentSession, type TextToSpeechAudioPacket } from "@kuralle-syrinx/core";
import { RealtimeBridge, fromOpenAIRealtime } from "@kuralle-syrinx/realtime";
import { CartesiaTTSPlugin } from "@kuralle-syrinx/cartesia";
import { createVoiceSessionRecorder } from "@kuralle-syrinx/recorder";
import { createNodeWsSocket } from "@kuralle-syrinx/ws/node";

import { ensureRepoRootDotenv, readPcm16Mono16kWav } from "../src/run-one-turn.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const FIX = (n: string): string => join(PKG_ROOT, "test", "fixtures", n);
const TURN_FIXTURES = ["university-support-add-drop.wav", "university-cs-masters-deadline.wav", "what-did-i-just-ask.wav"];
const OUTPUT_DIR = join(PKG_ROOT, "test", "performance", "runs", "half-cascade-multiturn");
const SESSION_ID = "conversation";
const INPUT_RATE = 16_000;
const ASSISTANT_RATE = 24_000;
const FRAME = 320;

function toBytes(s: Readonly<Int16Array>): Uint8Array { return new Uint8Array(s.buffer, s.byteOffset, s.byteLength); }
function frameAt(s: Readonly<Int16Array>, off: number): Int16Array { const f = new Int16Array(FRAME); const end = Math.min(off + FRAME, s.length); if (end > off) f.set(s.subarray(off, end)); return f; }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  const apiKey = process.env["OPENAI_API_KEY"]?.trim();
  const cartesiaKey = process.env["CARTESIA_API_KEY"]?.trim();
  if (!apiKey) throw new Error("missing OPENAI_API_KEY");
  if (!cartesiaKey) throw new Error("missing CARTESIA_API_KEY");
  await mkdir(OUTPUT_DIR, { recursive: true });

  const adapter = fromOpenAIRealtime({
    apiKey,
    socketFactory: createNodeWsSocket,
    modalities: ["text"],
    turnDetection: { type: "server_vad", silence_duration_ms: 500 },
    instructions:
      "You are a friendly university enrollment assistant on a phone call. Answer in ONE or TWO short, " +
      "spoken sentences. Be concise and natural; remember what the caller said earlier in the call.",
  });
  const bridge = new RealtimeBridge(adapter, undefined, undefined, { textOnly: true });

  const recorderDir = join(OUTPUT_DIR, "recorder");
  const session = new VoiceAgentSession({
    plugins: { realtime: {}, cartesia: { api_key: cartesiaKey, sample_rate: ASSISTANT_RATE }, recorder: {} },
    endpointingOwner: "timer",
  });
  session.registerPlugin("realtime", bridge);
  session.registerPlugin("cartesia", new CartesiaTTSPlugin());
  session.registerPlugin("recorder", createVoiceSessionRecorder({
    outputDir: recorderDir,
    sessionId: SESSION_ID,
    userSampleRateHz: INPUT_RATE,
    assistantSampleRateHz: ASSISTANT_RATE,
  }));

  let lastAudioMs = 0;
  let turnAudioBytes = 0;
  session.bus.on<TextToSpeechAudioPacket>("tts.audio", (pkt) => { lastAudioMs = Date.now(); turnAudioBytes += pkt.audio.byteLength; });

  await session.start();
  const contextId = crypto.randomUUID(); // one call id across turns (telephony-style reuse)
  const summary: Array<{ turn: number; fixture: string; assistantAudioBytes: number }> = [];

  for (let t = 0; t < TURN_FIXTURES.length; t++) {
    const pcm = readPcm16Mono16kWav(FIX(TURN_FIXTURES[t]!));
    turnAudioBytes = 0;
    // stream the user's question
    for (let off = 0; off < pcm.length; off += FRAME) {
      session.bus.push(Route.Main, { kind: "user.audio_received", contextId, timestampMs: Date.now(), audio: toBytes(frameAt(pcm, off)) });
      await sleep(20);
    }
    // trailing silence so server_vad detects end-of-turn
    for (let p = 0; p < 40; p++) { session.bus.push(Route.Main, { kind: "user.audio_received", contextId, timestampMs: Date.now(), audio: toBytes(new Int16Array(FRAME)) }); await sleep(20); }

    // wait for the assistant reply to finish (quiescence: no new audio for 2s), bounded
    lastAudioMs = 0;
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      await sleep(300);
      if (lastAudioMs > 0 && Date.now() - lastAudioMs > 2000) break;
    }
    summary.push({ turn: t + 1, fixture: TURN_FIXTURES[t]!, assistantAudioBytes: turnAudioBytes });
    await sleep(400); // brief gap between turns
  }

  await session.close();
  await adapter.close();

  const convWav = join(recorderDir, SESSION_ID, "conversation.wav");
  const listenPath = join(OUTPUT_DIR, "conversation.wav");
  await copyFile(convWav, listenPath).catch(() => {});
  console.log(JSON.stringify({ ok: summary.every((s) => s.assistantAudioBytes > 0), mode: "half-cascade multi-turn", turns: summary, conversationWav: listenPath }));

  process.exit(summary.every((s) => s.assistantAudioBytes > 0) ? 0 : 1);
}
main().catch((err: unknown) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
