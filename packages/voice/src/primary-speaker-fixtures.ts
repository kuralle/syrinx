// SPDX-License-Identifier: MIT
//
// Synthetic PCM fixtures for primary-speaker gate tests.

import { pcm16SamplesToBytes } from "./audio/pcm.js";

export function synthesizeTonePcm16(options: {
  frequencyHz: number;
  durationMs: number;
  sampleRateHz?: number;
  amplitude?: number;
  phaseRad?: number;
}): Uint8Array {
  const sampleRateHz = options.sampleRateHz ?? 16000;
  const amplitude = options.amplitude ?? 0.35;
  const phaseRad = options.phaseRad ?? 0;
  const sampleCount = Math.max(1, Math.round((options.durationMs * sampleRateHz) / 1000));
  const samples = new Int16Array(sampleCount);
  const omega = (2 * Math.PI * options.frequencyHz) / sampleRateHz;
  for (let i = 0; i < sampleCount; i += 1) {
    const value = Math.sin(omega * i + phaseRad) * amplitude * 32767;
    samples[i] = Math.max(-32768, Math.min(32767, Math.round(value)));
  }
  return pcm16SamplesToBytes(samples);
}

export function mixPcm16(chunks: Uint8Array[], weights: number[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  const maxLen = Math.max(...chunks.map((c) => c.byteLength));
  const out = new Int16Array(maxLen / 2);
  for (let c = 0; c < chunks.length; c += 1) {
    const chunk = chunks[c]!;
    const weight = weights[c] ?? 1;
    const samples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 2);
    for (let i = 0; i < samples.length; i += 1) {
      const mixed = (out[i] ?? 0) + samples[i]! * weight;
      out[i] = Math.max(-32768, Math.min(32767, Math.round(mixed)));
    }
  }
  return pcm16SamplesToBytes(out);
}

export const PRIMARY_SPEAKER_TONE_HZ = 280;
export const BYSTANDER_SPEAKER_TONE_HZ = 2100;
export const ASSISTANT_ECHO_TONE_HZ = 520;
