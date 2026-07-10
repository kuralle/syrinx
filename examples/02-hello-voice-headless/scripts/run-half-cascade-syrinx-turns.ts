// SPDX-License-Identifier: MIT
//
// Half-cascade C3 live proof (RFC docs/rfc-half-cascade.md, REQ-6): Syrinx OWNS turn
// detection. The realtime front runs text-only with server VAD DISABLED (turnDetection:null),
// so the provider does NOT auto-respond. Only Syrinx's own end-of-turn signal
// (eos.turn_complete) drives the provider via bridge syrinxTurns -> adapter.requestResponse.
//
// Asserts: (1) with the buffer appended but NO eos fired, the provider stays silent
// (no tts.audio) — proving server VAD is off and Syrinx owns the turn; (2) after Syrinx
// fires eos.turn_complete, the provider responds and Cartesia produces the audio.

import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Route, VoiceAgentSession, type EndOfSpeechPacket, type TextToSpeechAudioPacket, type TextToSpeechEndPacket } from "@kuralle-syrinx/core";
import { RealtimeBridge, fromOpenAIRealtime } from "@kuralle-syrinx/realtime";
import { CartesiaTTSPlugin } from "@kuralle-syrinx/cartesia";
import { createNodeWsSocket } from "@kuralle-syrinx/ws/node";

import { ensureRepoRootDotenv, readPcm16Mono16kWav } from "../src/run-one-turn.js";

const require = createRequire(import.meta.url);
const { WaveFile } = require("wavefile") as typeof import("wavefile");

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const FIXTURE_PATH = join(PKG_ROOT, "test", "fixtures", "university-support-add-drop.wav");
const OUTPUT_DIR = join(PKG_ROOT, "test", "performance", "runs", "half-cascade-syrinx-turns");
const RATE = 16_000;
const FRAME_SAMPLES = 320;

function pcmToBytes(s: Readonly<Int16Array>): Uint8Array { return new Uint8Array(s.buffer, s.byteOffset, s.byteLength); }
function sliceFrame(s: Readonly<Int16Array>, off: number): Int16Array { const f = new Int16Array(FRAME_SAMPLES); const end = Math.min(off + FRAME_SAMPLES, s.length); if (end > off) f.set(s.subarray(off, end)); return f; }
function merge(cs: readonly Uint8Array[]): Uint8Array { const t = cs.reduce((n, c) => n + c.byteLength, 0); const m = new Uint8Array(t); let o = 0; for (const c of cs) { m.set(c, o); o += c.byteLength; } return m; }
function nonSilent(cs: readonly Uint8Array[]): boolean { const b = merge(cs); if (b.byteLength < 4) return false; const s = new Int16Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 2)); let p = 0; for (const x of s) p = Math.max(p, Math.abs(x)); return p > 100; }
function writeWav(path: string, cs: readonly Uint8Array[]): Promise<void> { const b = merge(cs); const s = new Int16Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 2)); const w = new WaveFile(); w.fromScratch(1, RATE, "16", s); return writeFile(path, Buffer.from(w.toBuffer())); }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  const apiKey = process.env["OPENAI_API_KEY"]?.trim();
  const cartesiaKey = process.env["CARTESIA_API_KEY"]?.trim();
  if (!apiKey) throw new Error("missing OPENAI_API_KEY");
  if (!cartesiaKey) throw new Error("missing CARTESIA_API_KEY");
  await mkdir(OUTPUT_DIR, { recursive: true });

  const pcm = readPcm16Mono16kWav(FIXTURE_PATH);
  // text-only front, server VAD OFF — Syrinx owns turn detection.
  const adapter = fromOpenAIRealtime({ apiKey, socketFactory: createNodeWsSocket, modalities: ["text"], turnDetection: null });
  const bridge = new RealtimeBridge(adapter, undefined, undefined, { textOnly: true, syrinxTurns: true });

  const session = new VoiceAgentSession({
    plugins: { realtime: {}, cartesia: { api_key: cartesiaKey, sample_rate: RATE } },
    endpointingOwner: "timer",
  });
  session.registerPlugin("realtime", bridge);
  session.registerPlugin("cartesia", new CartesiaTTSPlugin());

  const chunks: Uint8Array[] = [];
  const providers = new Set<string>();
  let responseContextId = "";
  let firstAudioMs = 0;
  const offAudio = session.bus.on<TextToSpeechAudioPacket>("tts.audio", (pkt) => {
    if (!responseContextId) responseContextId = pkt.contextId;
    if (pkt.contextId !== responseContextId) return;
    if (firstAudioMs === 0) firstAudioMs = Date.now();
    if (pkt.provider?.["name"]) providers.add(String(pkt.provider["name"]));
    chunks.push(pkt.audio);
  });
  const ttsEnd = new Promise<void>((resolve, reject) => {
    const to = setTimeout(() => { off(); reject(new Error("tts.end timeout")); }, 60_000);
    const off = session.bus.on<TextToSpeechEndPacket>("tts.end", (pkt) => { if (responseContextId && pkt.contextId !== responseContextId) return; clearTimeout(to); off(); resolve(); });
  });

  await session.start();
  const ctx = crypto.randomUUID();
  let off = 0;
  while (off < pcm.length) { session.bus.push(Route.Main, { kind: "user.audio_received", contextId: ctx, timestampMs: Date.now(), audio: pcmToBytes(sliceFrame(pcm, off)) }); off += FRAME_SAMPLES; await sleep(20); }

  // PHASE 1: buffer appended, but Syrinx has NOT signalled end-of-turn. With server VAD off,
  // the provider must NOT respond. Wait and assert silence.
  await sleep(2500);
  const autoResponded = chunks.length > 0;

  // PHASE 2: Syrinx endpointing fires end-of-turn -> bridge calls adapter.requestResponse.
  const eosAtMs = Date.now();
  session.bus.push(Route.Main, { kind: "eos.turn_complete", contextId: ctx, timestampMs: eosAtMs, text: "", transcripts: [] } satisfies EndOfSpeechPacket);

  await ttsEnd;
  offAudio();

  const ok = !autoResponded && nonSilent(chunks) && providers.has("cartesia") && !providers.has("openai");
  const outPath = join(OUTPUT_DIR, "audio-out.wav");
  await writeWav(outPath, chunks);
  console.log(JSON.stringify({
    ok, mode: "half-cascade + syrinx-owned turns", serverVad: "off (turnDetection:null)",
    provider_auto_responded_before_eos: autoResponded, tts: [...providers],
    ttfa_after_eos_ms: firstAudioMs > 0 ? firstAudioMs - eosAtMs : -1,
    nonSilent: nonSilent(chunks), audioBytes: merge(chunks).byteLength, outPath,
  }));

  await session.close();
  await adapter.close();
  process.exit(ok ? 0 : 1);
}
main().catch((err: unknown) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
