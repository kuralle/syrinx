// SPDX-License-Identifier: MIT
//
// Live listen demo for background audio: real Deepgram Aura TTS rendered
// through the actual BackgroundAudioMixer, written to two local WAVs —
//   mixed.wav : what the caller hears (bed + ducked speech + thinking loop)
//   clean.wav : what the recorder keeps (speech only, silence in the gaps)
//
// Timeline: 2s comfort noise → assistant sentence (bed ducked under speech) →
// 2.5s "thinking" (bed + thinking loop) → second sentence → 2s idle tail.
// Assets are generated in-script (filtered brown noise ambience, soft
// keyboard-ish thinking ticks) so nothing external is needed.
//
// Usage: pnpm -C examples/02-hello-voice-headless smoke:background-audio-listen
// Requires DEEPGRAM_API_KEY. Cost: two short Aura TTS syntheses.

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import {
  PipelineBusImpl,
  Route,
  type TextToSpeechAudioPacket,
} from "@kuralle-syrinx/core";
import { pcm16BytesToSamples, pcm16SamplesToBytes } from "@kuralle-syrinx/core/audio";
import { DeepgramTTSPlugin } from "@kuralle-syrinx/deepgram";
import { pcm16ToWav } from "@kuralle-syrinx/recorder/wav";
import { BackgroundAudioMixer } from "@kuralle-syrinx/server-websocket";

loadEnv({ path: resolve(import.meta.dirname, "../../../.env") });
if (!process.env["DEEPGRAM_API_KEY"]) {
  console.error("DEEPGRAM_API_KEY missing");
  process.exit(1);
}

const RATE = 16000;
const OUT_DIR = resolve(import.meta.dirname, "../test/performance/runs/background-audio-demo");

// --- deterministic generated assets ------------------------------------------------

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/**
 * Office-ish room tone: double-filtered brown noise with a slow breathing
 * modulation — air, not hiss. 8s loop (long enough that the ear doesn't catch
 * the repeat).
 */
function ambiencePcm(): Int16Array {
  const rand = lcg(42);
  const out = new Int16Array(RATE * 8);
  let level = 0;
  let smooth = 0;
  for (let i = 0; i < out.length; i += 1) {
    level = level * 0.96 + (rand() * 2 - 1) * 900; // keep some mid-band: laptop speakers can't reproduce pure rumble
    smooth = smooth * 0.75 + level * 0.25; // gentler second pole
    const breathe = 1 + 0.22 * Math.sin((2 * Math.PI * i) / (RATE * 7)); // ~7s swell
    out[i] = Math.max(-7000, Math.min(7000, Math.round(smooth * breathe)));
  }
  return out;
}

/**
 * Unhurried typing: soft band-limited key thocks in bursts of 3–7 strokes
 * (~110–210ms apart — real typing pace), separated by 500–1400ms thinking
 * pauses. Each thock has a 3ms attack and a ~28ms exponential tail instead of
 * a hard click. 8s loop.
 */
function thinkingPcm(): Int16Array {
  const rand = lcg(7);
  const out = new Int16Array(RATE * 8);
  const attack = Math.round(RATE * 0.003);
  const tail = Math.round(RATE * 0.055);
  let cursor = Math.round(RATE * 0.15);
  while (cursor < out.length) {
    const strokes = 3 + Math.floor(rand() * 5); // a burst of 3–7 keys
    for (let k = 0; k < strokes && cursor < out.length; k += 1) {
      const amp = 3500 + rand() * 2500; // every key lands differently
      let lowpassed = 0;
      for (let i = 0; i < attack + tail && cursor + i < out.length; i += 1) {
        lowpassed = lowpassed * 0.72 + (rand() * 2 - 1) * amp * 0.28; // muffled thock, not static
        const env = i < attack ? i / attack : Math.exp(-(i - attack) / (RATE * 0.028));
        out[cursor + i] = Math.max(-9000, Math.min(9000, Math.round(lowpassed * env)));
      }
      cursor += Math.round(RATE * (0.11 + rand() * 0.1)); // 110–210ms between keys
    }
    cursor += Math.round(RATE * (0.5 + rand() * 0.9)); // 0.5–1.4s pause: typing, then thinking
  }
  return out;
}

// --- live TTS ------------------------------------------------------------------------

async function synthesize(text: string, contextId: string): Promise<Uint8Array[]> {
  const bus = new PipelineBusImpl();
  const drain = bus.start();
  const chunks: Uint8Array[] = [];
  let done = false;
  bus.on("tts.audio", (pkt) => {
    chunks.push((pkt as TextToSpeechAudioPacket).audio);
  });
  bus.on("tts.end", () => {
    done = true;
  });

  const tts = new DeepgramTTSPlugin();
  // finish_timeout_ms: 0 — the plugin's 2s Flushed wedge-guard force-emits
  // tts.end mid-stream for one-shot capture like this (text+done pushed
  // together, sentences longer than 2s). With it disabled, tts.end means the
  // real Flushed ack: every audio byte has been delivered.
  await tts.initialize(bus, {
    api_key: process.env["DEEPGRAM_API_KEY"],
    sample_rate: RATE,
    finish_timeout_ms: 0,
  });
  bus.push(Route.Main, { kind: "tts.text", contextId, timestampMs: Date.now(), text });
  bus.push(Route.Main, { kind: "tts.done", contextId, timestampMs: Date.now(), fullText: text });

  const deadline = Date.now() + 15_000;
  while (!done && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  await tts.close();
  bus.stop();
  await drain;
  if (chunks.length === 0) throw new Error(`TTS produced no audio for: ${text}`);
  const durationMs = chunks.reduce((ms, c) => ms + (c.byteLength / 2 / RATE) * 1000, 0);
  // A chopped capture is worse than a failed one — refuse to render half a sentence.
  if (durationMs < 2500) throw new Error(`TTS capture suspiciously short (${Math.round(durationMs)}ms) for: ${text}`);
  console.log(`  captured ${(durationMs / 1000).toFixed(1)}s for: ${text.slice(0, 40)}...`);
  return chunks;
}

// --- timeline rendering ----------------------------------------------------------------

function main(mixer: BackgroundAudioMixer, sentence1: Uint8Array[], sentence2: Uint8Array[]): void {
  const mixed: Uint8Array[] = [];
  const clean: Uint8Array[] = [];
  let vt = 1_000_000; // virtual clock (ms) — mixer calls take explicit nowMs

  const silence = (ms: number): Uint8Array => new Uint8Array((RATE * ms * 2) / 1000);
  const pushIdle = (ms: number): void => {
    for (let t = 0; t < ms; t += 20) {
      mixed.push(mixer.idleFrame(20, RATE, vt) ?? silence(20));
      clean.push(silence(20));
      vt += 20;
    }
  };
  const pushSpeech = (chunks: Uint8Array[]): void => {
    for (const chunk of chunks) {
      mixed.push(mixer.mix(chunk, RATE, vt)); // chunks arrive burst-fast; playout is serial
      clean.push(chunk);
    }
    const totalMs = chunks.reduce((ms, c) => ms + (c.byteLength / 2 / RATE) * 1000, 0);
    vt += Math.ceil(totalMs);
  };

  pushIdle(2000); // comfort noise before anyone speaks
  pushSpeech(sentence1);
  mixer.setThinking(true); // pending tool call → thinking loop over the bed
  pushIdle(3500); // long enough to hear a typing burst, a pause, and another burst
  mixer.setThinking(false);
  pushSpeech(sentence2);
  pushIdle(2000); // idle tail

  const concat = (parts: Uint8Array[]): Uint8Array => {
    const total = parts.reduce((n, p) => n + p.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
      out.set(p, offset);
      offset += p.byteLength;
    }
    return out;
  };

  // Shape the ending: the bed running at full level into an abrupt stop sounds
  // like the file was cut — fade the last 1.2s to silence (equal-power).
  const mixedPcm = concat(mixed);
  const tail = new Int16Array(mixedPcm.buffer, mixedPcm.byteOffset, mixedPcm.byteLength / 2);
  const fadeLen = Math.min(tail.length, Math.round(RATE * 1.2));
  for (let i = 0; i < fadeLen; i += 1) {
    const idx = tail.length - fadeLen + i;
    tail[idx] = Math.round(tail[idx]! * Math.cos((i / fadeLen) * (Math.PI / 2)));
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, "mixed.wav"), pcm16ToWav(mixedPcm, RATE, 1));
  writeFileSync(resolve(OUT_DIR, "clean.wav"), pcm16ToWav(concat(clean), RATE, 1));
}

const mixer = new BackgroundAudioMixer({
  ambient: { pcm: ambiencePcm(), sampleRateHz: RATE, gain: 0.45 }, // demo runs hot so the bed is unmistakable; production would sit lower
  thinking: { pcm: thinkingPcm(), sampleRateHz: RATE, gain: 0.4 },
  duckWhileSpeaking: 0.45,
  // fadeMs default (250ms equal-power) shapes the bed's start and each
  // thinking episode's entry/exit — no hard cuts.
});

const S1 = "Thanks for calling university support. Let me pull up the lab fee details for you.";
const S2 = "Okay, I found it. The lab fee for Biology one oh one is twenty five dollars per semester.";

console.log("Synthesizing two sentences with live Deepgram Aura...");
const sentence1 = await synthesize(S1, "demo-s1");
const sentence2 = await synthesize(S2, "demo-s2");
console.log(`Sentence 1: ${sentence1.length} chunks; sentence 2: ${sentence2.length} chunks.`);

main(mixer, sentence1, sentence2);
console.log(`\nWrote:\n  ${resolve(OUT_DIR, "mixed.wav")}   <- what the caller hears\n  ${resolve(OUT_DIR, "clean.wav")}   <- what the recorder keeps`);
console.log(`\nListen:  afplay "${resolve(OUT_DIR, "mixed.wav")}"`);
