// SPDX-License-Identifier: MIT
//
// Half-cascade SINHALA payoff (RFC docs/rfc-half-cascade.md §1): the reason half-cascade exists.
// Native realtime S2S emits clean Sinhala TEXT but code-switches to English in the AUDIO. Half-cascade
// runs the front TEXT-ONLY (native comprehension, Sinhala text) and voices it through Syrinx's own TTS
// (Zeta, a Sinhala model) — so the AUDIO is correct Sinhala.
//
// Front comprehends the English fixture question, is instructed to answer in Sinhala, streams Sinhala
// text -> segmenter -> tts.text -> Zeta (48kHz -> engine rate) -> tts.audio. We collect until the audio
// goes quiet (Zeta emits tts.end per segment), then write a WAV to listen to.

import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Route, VoiceAgentSession, type TextToSpeechAudioPacket } from "@kuralle-syrinx/core";
import { RealtimeBridge, fromOpenAIRealtime } from "@kuralle-syrinx/realtime";
import { OpenAICompatibleTTSPlugin } from "@kuralle-syrinx/openai-tts";
import { createNodeWsSocket } from "@kuralle-syrinx/ws/node";

import { ensureRepoRootDotenv, readPcm16Mono16kWav } from "../src/run-one-turn.js";

const require = createRequire(import.meta.url);
const { WaveFile } = require("wavefile") as typeof import("wavefile");

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const FIXTURE_PATH = join(PKG_ROOT, "test", "fixtures", "university-support-add-drop.wav");
const OUTPUT_DIR = join(PKG_ROOT, "test", "performance", "runs", "half-cascade-sinhala");
const ENGINE_RATE = 24_000; // Zeta is 48kHz; 24kHz is a clean downsample (crisper than 16k)
const FRAME_SAMPLES = 320;

function pcmToBytes(s: Readonly<Int16Array>): Uint8Array { return new Uint8Array(s.buffer, s.byteOffset, s.byteLength); }
function sliceFrame(s: Readonly<Int16Array>, off: number): Int16Array { const f = new Int16Array(FRAME_SAMPLES); const end = Math.min(off + FRAME_SAMPLES, s.length); if (end > off) f.set(s.subarray(off, end)); return f; }
function merge(cs: readonly Uint8Array[]): Uint8Array { const t = cs.reduce((n, c) => n + c.byteLength, 0); const m = new Uint8Array(t); let o = 0; for (const c of cs) { m.set(c, o); o += c.byteLength; } return m; }
function nonSilent(cs: readonly Uint8Array[]): boolean { const b = merge(cs); if (b.byteLength < 4) return false; const s = new Int16Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 2)); let p = 0; for (const x of s) p = Math.max(p, Math.abs(x)); return p > 100; }
function writeWav(path: string, cs: readonly Uint8Array[]): Promise<void> { const b = merge(cs); const s = new Int16Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 2)); const w = new WaveFile(); w.fromScratch(1, ENGINE_RATE, "16", s); return writeFile(path, Buffer.from(w.toBuffer())); }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  const apiKey = process.env["OPENAI_API_KEY"]?.trim();
  if (!apiKey) throw new Error("missing OPENAI_API_KEY");
  await mkdir(OUTPUT_DIR, { recursive: true });

  const pcm = readPcm16Mono16kWav(FIXTURE_PATH);
  const adapter = fromOpenAIRealtime({
    apiKey,
    socketFactory: createNodeWsSocket,
    modalities: ["text"],
    turnDetection: { type: "server_vad", silence_duration_ms: 500 },
    instructions:
      "You are a friendly university enrollment assistant. ALWAYS reply ONLY in Sinhala (සිංහල). " +
      "Keep it to at most two short sentences. Do not use any English words.",
  });
  const bridge = new RealtimeBridge(adapter, undefined, undefined, { textOnly: true });

  const session = new VoiceAgentSession({
    plugins: {
      realtime: {},
      zeta: {
        base_url: "https://asyncdotengineering--zeta-tts-api-zetattsapi.us-east.modal.direct/v1",
        model: "zeta",
        source_sample_rate_hz: 48000,
        sample_rate: ENGINE_RATE,
        tempo: 1.0,
        extra_body: { task_type: "Base", num_steps: 8 },
      },
    },
    endpointingOwner: "timer",
  });
  session.registerPlugin("realtime", bridge);
  session.registerPlugin("zeta", new OpenAICompatibleTTSPlugin());

  const chunks: Uint8Array[] = [];
  const providers = new Set<string>();
  let responseContextId = "";
  let firstAudioMs = 0;
  let lastAudioMs = 0;
  let userTurnEndMs = 0;
  session.bus.on<TextToSpeechAudioPacket>("tts.audio", (pkt) => {
    if (!responseContextId) responseContextId = pkt.contextId;
    if (pkt.contextId !== responseContextId) return;
    const now = Date.now();
    if (firstAudioMs === 0) firstAudioMs = now;
    lastAudioMs = now;
    if (pkt.provider?.["name"]) providers.add(String(pkt.provider["name"]));
    chunks.push(pkt.audio);
  });

  await session.start();
  const ctx = crypto.randomUUID();
  let off = 0;
  while (off < pcm.length) { session.bus.push(Route.Main, { kind: "user.audio_received", contextId: ctx, timestampMs: Date.now(), audio: pcmToBytes(sliceFrame(pcm, off)) }); off += FRAME_SAMPLES; await sleep(20); }
  userTurnEndMs = Date.now();
  for (let pad = 0; pad < 60; pad += 1) { session.bus.push(Route.Main, { kind: "user.audio_received", contextId: ctx, timestampMs: Date.now(), audio: pcmToBytes(new Int16Array(FRAME_SAMPLES)) }); await sleep(20); }

  // Quiescence-based end: wait until audio started and no new audio for 2.5s (Zeta emits tts.end per segment).
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await sleep(300);
    if (firstAudioMs > 0 && Date.now() - lastAudioMs > 2500) break;
  }

  const outPath = join(OUTPUT_DIR, "audio-out.wav");
  await writeWav(outPath, chunks);
  const durationS = merge(chunks).byteLength / 2 / ENGINE_RATE;
  console.log(JSON.stringify({
    ok: nonSilent(chunks) && providers.has("openai"),
    mode: "half-cascade SINHALA", front: "gpt-realtime (text-only, Sinhala instructed)", tts: [...providers],
    v2v_ttfa_ms: firstAudioMs > 0 ? firstAudioMs - userTurnEndMs : -1,
    durationS: Number(durationS.toFixed(2)), audioBytes: merge(chunks).byteLength, sampleRateHz: ENGINE_RATE,
    nonSilent: nonSilent(chunks), outPath,
  }));

  await session.close();
  await adapter.close();
  process.exit(nonSilent(chunks) && providers.has("openai") ? 0 : 1);
}
main().catch((err: unknown) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
