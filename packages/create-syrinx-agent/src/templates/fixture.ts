// SPDX-License-Identifier: MIT
//
// A minimal, self-contained mono 16 kHz PCM16 WAV fixture (0.5s of silence)
// so `check:turn` (syrinx turn --in test/fixtures/smoke.wav) has something to
// replay without depending on any file outside the generated project. It
// carries no expected-transcript sidecar — see AGENTS.md for what that means.

const SAMPLE_RATE = 16_000;
const DURATION_SECONDS = 0.5;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

export function buildSmokeWav(): Buffer {
  const numSamples = Math.floor(SAMPLE_RATE * DURATION_SECONDS);
  const dataBytes = numSamples * CHANNELS * (BITS_PER_SAMPLE / 8);
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8), 28); // byte rate
  buffer.writeUInt16LE(CHANNELS * (BITS_PER_SAMPLE / 8), 32); // block align
  buffer.writeUInt16LE(BITS_PER_SAMPLE, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  // PCM16 silence: the buffer is already zero-filled by Buffer.alloc.

  return buffer;
}
