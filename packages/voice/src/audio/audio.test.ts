// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { pcm16BytesToSamples, pcm16SamplesToBytes, bigEndianPcm16BytesToSamples, pcm16SamplesToBigEndianBytes } from "./pcm.js";
import { decodeMuLawToPcm16, encodePcm16ToMuLaw } from "./mulaw.js";
import { resamplePcm16, StreamingPcm16Resampler } from "./resample.js";

// ── PCM byte ↔ sample conversions ──────────────────────────────────────────

describe("pcm16BytesToSamples (little-endian)", () => {
  it("decodes a known LE byte sequence", () => {
    // [0x01, 0x00] = 1 in LE;  [0xFF, 0x7F] = 32767;  [0x00, 0x80] = -32768
    const bytes = new Uint8Array([0x01, 0x00, 0xff, 0x7f, 0x00, 0x80]);
    const samples = pcm16BytesToSamples(bytes);
    expect(samples[0]).toBe(1);
    expect(samples[1]).toBe(32767);
    expect(samples[2]).toBe(-32768);
  });

  it("throws on odd byte length", () => {
    expect(() => pcm16BytesToSamples(new Uint8Array(3))).toThrow(/even/);
  });

  it("round-trips through pcm16SamplesToBytes", () => {
    const original = new Int16Array([0, 1, -1, 32767, -32768, 1000, -1000]);
    const bytes = pcm16SamplesToBytes(original);
    const recovered = pcm16BytesToSamples(bytes);
    expect(Array.from(recovered)).toEqual(Array.from(original));
  });
});

describe("pcm16SamplesToBytes (little-endian)", () => {
  it("encodes a known sample sequence to LE bytes", () => {
    const samples = new Int16Array([1, 32767, -32768]);
    const bytes = pcm16SamplesToBytes(samples);
    expect(bytes[0]).toBe(0x01);
    expect(bytes[1]).toBe(0x00);
    expect(bytes[2]).toBe(0xff);
    expect(bytes[3]).toBe(0x7f);
    expect(bytes[4]).toBe(0x00);
    expect(bytes[5]).toBe(0x80);
  });
});

describe("bigEndianPcm16BytesToSamples", () => {
  it("decodes a known BE byte sequence", () => {
    // BE: [0x00, 0x01] = 1;  [0x7F, 0xFF] = 32767;  [0x80, 0x00] = -32768
    const bytes = new Uint8Array([0x00, 0x01, 0x7f, 0xff, 0x80, 0x00]);
    const samples = bigEndianPcm16BytesToSamples(bytes);
    expect(samples[0]).toBe(1);
    expect(samples[1]).toBe(32767);
    expect(samples[2]).toBe(-32768);
  });

  it("throws on odd byte length", () => {
    expect(() => bigEndianPcm16BytesToSamples(new Uint8Array(3))).toThrow(/even/);
  });

  it("round-trips through pcm16SamplesToBigEndianBytes", () => {
    const original = new Int16Array([0, 1, -1, 32767, -32768, 1000]);
    const bytes = pcm16SamplesToBigEndianBytes(original);
    const recovered = bigEndianPcm16BytesToSamples(bytes);
    expect(Array.from(recovered)).toEqual(Array.from(original));
  });
});

describe("LE vs BE byte order", () => {
  it("produces distinct byte sequences for the same samples", () => {
    const samples = new Int16Array([256]); // LE: [0x00, 0x01], BE: [0x01, 0x00]
    const le = pcm16SamplesToBytes(samples);
    const be = pcm16SamplesToBigEndianBytes(samples);
    expect(le[0]).not.toBe(be[0]);
  });

  it("LE bytes decoded as BE yield wrong values and vice versa", () => {
    const samples = new Int16Array([1000, -500]);
    const leBytes = pcm16SamplesToBytes(samples);
    const beBytes = pcm16SamplesToBigEndianBytes(samples);
    // Cross-decode: LE bytes read as BE should NOT equal original
    const mismatch = bigEndianPcm16BytesToSamples(leBytes);
    expect(mismatch[0]).not.toBe(1000);
    // BE bytes read as LE should NOT equal original
    const mismatch2 = pcm16BytesToSamples(beBytes);
    expect(mismatch2[0]).not.toBe(1000);
  });
});

// ── μ-law codec ─────────────────────────────────────────────────────────────

describe("μ-law round-trip", () => {
  it("round-trips silence exactly", () => {
    const silence = new Int16Array(160);
    const encoded = encodePcm16ToMuLaw(silence);
    const decoded = decodeMuLawToPcm16(encoded);
    for (let i = 0; i < decoded.length; i += 1) {
      // silence encodes to the mid-code and decodes back to near-zero
      expect(Math.abs(decoded[i]!)).toBeLessThanOrEqual(8);
    }
  });

  it("round-trips a sine wave within μ-law quantization tolerance", () => {
    const N = 160;
    const input = new Int16Array(N);
    for (let i = 0; i < N; i += 1) {
      input[i] = Math.round(16000 * Math.sin((2 * Math.PI * 1000 * i) / 8000));
    }
    const encoded = encodePcm16ToMuLaw(input);
    expect(encoded.length).toBe(N);
    const decoded = decodeMuLawToPcm16(encoded);
    // μ-law is lossy; allow ≤5% full-scale error (~1638 counts)
    for (let i = 0; i < N; i += 1) {
      expect(Math.abs(decoded[i]! - input[i]!)).toBeLessThanOrEqual(1638);
    }
  });

  it("preserves sign correctly", () => {
    const positive = new Int16Array([10000]);
    const negative = new Int16Array([-10000]);
    const decPos = decodeMuLawToPcm16(encodePcm16ToMuLaw(positive));
    const decNeg = decodeMuLawToPcm16(encodePcm16ToMuLaw(negative));
    expect(decPos[0]).toBeGreaterThan(0);
    expect(decNeg[0]).toBeLessThan(0);
  });
});

// ── Resampler ───────────────────────────────────────────────────────────────

describe("resamplePcm16 — identity and length", () => {
  it("returns the same reference when rates are equal", () => {
    const input = new Int16Array([100, 200, 300]);
    const output = resamplePcm16(input, 16000, 16000);
    expect(output).toBe(input);
  });

  it("returns empty array for empty input", () => {
    const output = resamplePcm16(new Int16Array(0), 16000, 8000);
    expect(output.length).toBe(0);
  });

  it("produces correct output length for 2× upsample", () => {
    const input = new Int16Array(80);
    const output = resamplePcm16(input, 8000, 16000);
    expect(output.length).toBe(160);
  });

  it("produces correct output length for 2× downsample", () => {
    const input = new Int16Array(160);
    const output = resamplePcm16(input, 16000, 8000);
    expect(output.length).toBe(80);
  });

  it("produces correct output length for 3× downsample", () => {
    const input = new Int16Array(240);
    const output = resamplePcm16(input, 24000, 8000);
    expect(output.length).toBe(80);
  });

  it("produces correct output length for 48k→16k (3× downsample)", () => {
    const input = new Int16Array(480);
    const output = resamplePcm16(input, 48000, 16000);
    expect(output.length).toBe(160);
  });
});

describe("resamplePcm16 — upsample fidelity", () => {
  it("preserves a DC signal on upsample", () => {
    // A constant signal should remain constant after upsampling.
    const dc = 10000;
    const input = new Int16Array(80).fill(dc);
    const output = resamplePcm16(input, 8000, 16000);
    for (let i = 0; i < output.length; i += 1) {
      expect(output[i]).toBe(dc);
    }
  });
});

describe("resamplePcm16 — downsample fidelity", () => {
  it("preserves a DC signal on downsample in the interior (no boundary effects)", () => {
    // Use 640 input samples (40 ms @ 16 kHz) → 320 output samples @ 8 kHz.
    // With a 127-tap centered FIR (halfTaps=63), both sides of the filter are
    // fully populated for output indices m where:
    //   n0 - halfTaps >= 0  → n0 >= 63 → m >= 32
    //   n0 + halfTaps < 640 → n0 < 577 → m <= 288
    // Check m=40..280 to leave a comfortable margin on both ends.
    const dc = 10000;
    const input = new Int16Array(640).fill(dc);
    const output = resamplePcm16(input, 16000, 8000);
    expect(output.length).toBe(320);
    for (let i = 40; i <= 280; i += 1) {
      expect(Math.abs(output[i]! - dc)).toBeLessThanOrEqual(10);
    }
  });
});

// ── Anti-alias spectral test (F3 regression lock) ───────────────────────────
//
// Strategy: synthesize a 7 kHz tone at 16 kHz. When decimated to 8 kHz without
// a low-pass filter, 7 kHz aliases to 1 kHz (8000 − 7000). Compare the DFT
// magnitude at 1 kHz between the naive linear-interp baseline and the
// anti-aliased output. The spec requires ≥40 dB suppression of the alias.

function dftMagnitudeAtBin(samples: Int16Array, binIndex: number): number {
  // Compute a single DFT bin via direct evaluation (O(N)).
  let re = 0;
  let im = 0;
  const N = samples.length;
  for (let n = 0; n < N; n += 1) {
    const angle = (2 * Math.PI * binIndex * n) / N;
    re += samples[n]! * Math.cos(angle);
    im -= samples[n]! * Math.sin(angle);
  }
  return Math.sqrt(re * re + im * im);
}

function naiveDecimate16kTo8k(input: Int16Array): Int16Array {
  // Pure linear interpolation decimation — the pre-existing buggy baseline.
  const outputLength = Math.max(1, Math.round((input.length * 8000) / 16000));
  const output = new Int16Array(outputLength);
  const ratio = 2.0;
  for (let i = 0; i < outputLength; i += 1) {
    const pos = i * ratio;
    const lo = Math.floor(pos);
    const hi = Math.min(input.length - 1, lo + 1);
    const frac = pos - lo;
    output[i] = Math.round(input[lo]! * (1 - frac) + input[hi]! * frac);
  }
  return output;
}

describe("StreamingPcm16Resampler — chunk continuity", () => {
  it("preserves constant-amplitude PCM across successive 20ms chunks (stateless path rings)", () => {
    const chunkSamples = 320;
    const value = 10_000;
    const chunks = 10;
    const stateful = new StreamingPcm16Resampler(16_000, 8_000);

    for (let i = 0; i < chunks; i += 1) {
      const chunk = new Int16Array(chunkSamples).fill(value);
      const statefulOut = stateful.process(chunk);
      const statelessOut = resamplePcm16(chunk, 16_000, 8_000);
      if (i === 0) continue;

      const statefulSwing = Math.max(...statefulOut) - Math.min(...statefulOut);
      expect(statefulSwing).toBeLessThan(700);

      const statelessSwing = Math.max(...statelessOut) - Math.min(...statelessOut);
      expect(statelessSwing).toBeGreaterThan(3000);
      expect(Math.min(...statelessOut)).toBeLessThan(8000);
      expect(Math.max(...statelessOut)).toBeGreaterThan(10_000);
    }
  });
});

describe("resamplePcm16 — anti-alias spectral test (F3)", () => {
  it("attenuates 7 kHz alias by ≥40 dB compared to naive linear-interp", () => {
    // 100 ms of 7 kHz tone at 16 kHz (amplitude 20000).
    const N_IN = 1600;
    const AMPLITUDE = 20000;
    const FREQ_HZ = 7000;
    const SRC_RATE = 16000;
    const DST_RATE = 8000;

    const input = new Int16Array(N_IN);
    for (let n = 0; n < N_IN; n += 1) {
      input[n] = Math.round(AMPLITUDE * Math.sin((2 * Math.PI * FREQ_HZ * n) / SRC_RATE));
    }

    const naiveOutput = naiveDecimate16kTo8k(input);
    const aaOutput = resamplePcm16(input, SRC_RATE, DST_RATE);

    // 7 kHz aliases to 1 kHz (8000 - 7000) in the 8 kHz output.
    // DFT bin for 1 kHz with 800 output samples at 8 kHz: bin = 800 * 1000/8000 = 100.
    const aliasBin = Math.round((naiveOutput.length * 1000) / DST_RATE);

    const naiveMag = dftMagnitudeAtBin(naiveOutput, aliasBin);
    const aaMag = dftMagnitudeAtBin(aaOutput, aliasBin);

    // Guard: naive must actually have a strong alias (sanity-check the test itself).
    expect(naiveMag).toBeGreaterThan(AMPLITUDE * 100); // should be ~amplitude*N/2

    // Anti-aliased output alias must be ≥40 dB below the naive alias.
    const ratioDb = 20 * Math.log10(naiveMag / Math.max(1, aaMag));
    expect(ratioDb).toBeGreaterThanOrEqual(40);
  });
});
