// SPDX-License-Identifier: MIT
//
// Deterministic placeholder backchannel cue PCM (16 kHz mono). Real voice-matched
// assets + locale table are a follow-up — these shaped tones prove the byte-config path.

import { synthesizeTonePcm16 } from "@kuralle-syrinx/core";
import { pcm16BytesToSamples } from "@kuralle-syrinx/core/audio";
import type { BackgroundAudioSource } from "./background-audio.js";

const CUE_SAMPLE_RATE_HZ = 16_000;

function placeholderCue(frequencyHz: number, durationMs: number, gain: number): BackgroundAudioSource {
  const bytes = synthesizeTonePcm16({
    frequencyHz,
    durationMs,
    sampleRateHz: CUE_SAMPLE_RATE_HZ,
    amplitude: 0.35,
  });
  return { pcm: pcm16BytesToSamples(bytes), sampleRateHz: CUE_SAMPLE_RATE_HZ, gain };
}

/** Placeholder cue map — pass as `backgroundAudio.cues` at session init. */
export function buildPlaceholderBackchannelCues(): Readonly<Record<string, BackgroundAudioSource>> {
  return {
    mm_hmm: placeholderCue(440, 400, 0.65),
    yeah: placeholderCue(520, 350, 0.6),
    got_it: placeholderCue(380, 450, 0.6),
  };
}