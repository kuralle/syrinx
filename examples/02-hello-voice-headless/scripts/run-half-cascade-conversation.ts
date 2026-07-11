// SPDX-License-Identifier: MIT
//
// Half-cascade MULTI-TURN conversation you can listen to — sequenced like a real call:
//   [user question] → gap → [assistant reply] → gap → [next user question] → ...
// Built by capturing each turn's user fixture + the assistant's tts.audio and concatenating them
// in order (mono), so there is NO overlap (unlike a parallel-stereo recording where the faster-
// than-realtime TTS track misaligns). Env SINHALA=1 switches the front to reply in Sinhala via Zeta;
// otherwise English via Cartesia. Front = gpt-realtime-2 (text-only).

import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Route, VoiceAgentSession, StreamingPcm16Resampler, type TextToSpeechAudioPacket } from "@kuralle-syrinx/core";
import { RealtimeBridge, fromOpenAIRealtime } from "@kuralle-syrinx/realtime";
import { CartesiaTTSPlugin } from "@kuralle-syrinx/cartesia";
import { ZetaTTSPlugin } from "@kuralle-syrinx/zeta-tts";
import { createNodeWsSocket } from "@kuralle-syrinx/ws/node";

import { ensureRepoRootDotenv, readPcm16Mono16kWav } from "../src/run-one-turn.js";

const require = createRequire(import.meta.url);
const { WaveFile } = require("wavefile") as typeof import("wavefile");

const SINHALA = process.env["SINHALA"] === "1";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const FIX = (n: string): string => join(PKG_ROOT, "test", "fixtures", n);
const TURNS = ["university-support-add-drop.wav", "university-cs-masters-deadline.wav", "what-did-i-just-ask.wav"];
const OUTPUT_DIR = join(PKG_ROOT, "test", "performance", "runs", SINHALA ? "half-cascade-convo-sinhala" : "half-cascade-convo-english");
const INPUT_RATE = 16_000;
const RATE = 24_000; // assistant + final conversation rate
const FRAME = 320;

function toBytes(s: Readonly<Int16Array>): Uint8Array { return new Uint8Array(s.buffer, s.byteOffset, s.byteLength); }
function frameAt(s: Readonly<Int16Array>, off: number): Int16Array { const f = new Int16Array(FRAME); const end = Math.min(off + FRAME, s.length); if (end > off) f.set(s.subarray(off, end)); return f; }
function merge(cs: readonly Uint8Array[]): Uint8Array { const t = cs.reduce((n, c) => n + c.byteLength, 0); const m = new Uint8Array(t); let o = 0; for (const c of cs) { m.set(c, o); o += c.byteLength; } return m; }
function silence(seconds: number): Uint8Array { return new Uint8Array(Math.floor(RATE * seconds) * 2); }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  const apiKey = process.env["OPENAI_API_KEY"]?.trim();
  const cartesiaKey = process.env["CARTESIA_API_KEY"]?.trim();
  if (!apiKey) throw new Error("missing OPENAI_API_KEY");
  if (!SINHALA && !cartesiaKey) throw new Error("missing CARTESIA_API_KEY");
  await mkdir(OUTPUT_DIR, { recursive: true });

  const instructions = SINHALA
    ? "You are a friendly university enrollment assistant on a phone call. ALWAYS reply ONLY in Sinhala (සිංහල), in ONE short sentence. No English words. Remember what the caller said earlier."
    : "You are a friendly university enrollment assistant on a phone call. Reply in ONE short spoken sentence. Remember what the caller said earlier in the call.";

  const adapter = fromOpenAIRealtime({ apiKey, socketFactory: createNodeWsSocket, modalities: ["text"], turnDetection: { type: "server_vad", silence_duration_ms: 500 }, instructions });
  const bridge = new RealtimeBridge(adapter, undefined, undefined, { textOnly: true });

  const plugins = SINHALA
    ? { realtime: {}, zeta: { sample_rate: RATE, tempo: 0.9 } } // 10% slower (WSOLA, pitch-preserved) — Zeta's Sinhala prosody rushes
    : { realtime: {}, cartesia: { api_key: cartesiaKey!, sample_rate: RATE } };
  const session = new VoiceAgentSession({ plugins, endpointingOwner: "timer" });
  session.registerPlugin("realtime", bridge);
  session.registerPlugin(SINHALA ? "zeta" : "cartesia", SINHALA ? new ZetaTTSPlugin() : new CartesiaTTSPlugin());

  let current: Uint8Array[] = [];
  let lastAudioMs = 0;
  session.bus.on<TextToSpeechAudioPacket>("tts.audio", (pkt) => { lastAudioMs = Date.now(); current.push(pkt.audio); });

  await session.start();
  const ctx = crypto.randomUUID();
  const conversation: Uint8Array[] = [];
  const perTurn: Array<{ turn: number; assistantBytes: number }> = [];

  for (let t = 0; t < TURNS.length; t++) {
    const userPcm16 = readPcm16Mono16kWav(FIX(TURNS[t]!));
    // 1) the user's question, resampled to the conversation rate
    conversation.push(toBytes(new StreamingPcm16Resampler(INPUT_RATE, RATE).process(userPcm16)));
    conversation.push(silence(0.4));

    // 2) send the user audio to the front and capture the reply
    current = [];
    for (let off = 0; off < userPcm16.length; off += FRAME) { session.bus.push(Route.Main, { kind: "user.audio_received", contextId: ctx, timestampMs: Date.now(), audio: toBytes(frameAt(userPcm16, off)) }); await sleep(20); }
    for (let p = 0; p < 40; p++) { session.bus.push(Route.Main, { kind: "user.audio_received", contextId: ctx, timestampMs: Date.now(), audio: toBytes(new Int16Array(FRAME)) }); await sleep(20); }
    lastAudioMs = 0;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) { await sleep(300); if (lastAudioMs > 0 && Date.now() - lastAudioMs > 2500) break; }

    const assistant = merge(current);
    conversation.push(assistant);
    conversation.push(silence(0.8));
    perTurn.push({ turn: t + 1, assistantBytes: assistant.byteLength });
  }

  await session.close();
  await adapter.close();

  const bytes = merge(conversation);
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const wav = new WaveFile();
  wav.fromScratch(1, RATE, "16", samples);
  const outPath = join(OUTPUT_DIR, "conversation.wav");
  await writeFile(outPath, Buffer.from(wav.toBuffer()));

  console.log(JSON.stringify({ ok: perTurn.every((p) => p.assistantBytes > 0), language: SINHALA ? "sinhala" : "english", front: "gpt-realtime-2 (text-only)", tts: SINHALA ? "zeta" : "cartesia sonic-3", turns: perTurn, durationS: Number((samples.length / RATE).toFixed(1)), outPath }));
  process.exit(perTurn.every((p) => p.assistantBytes > 0) ? 0 : 1);
}
main().catch((err: unknown) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
