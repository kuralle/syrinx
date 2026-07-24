// SPDX-License-Identifier: MIT
//
// G.722 tests — round-trip SNR + known-answer smoke.
// NOT ITU-vector-certified (no embedded ITU G.722 Appendix test vectors).

import { describe, expect, it } from "vitest";
import {
  createG722DecoderState,
  createG722EncoderState,
  decodeG722,
  encodeG722,
  G722_SAMPLE_RATE_HZ,
} from "./g722.js";

/**
 * SNR with QMF group-delay alignment: recovered lags original by `delay` samples
 * (recovered[i + delay] ≈ original[i]).
 */
function snrDb(original: Int16Array, recovered: Int16Array, delay = 0): number {
  let signal = 0;
  let noise = 0;
  const start = 320;
  const end = Math.min(original.length, recovered.length - delay) - 8;
  for (let i = start; i < end; i += 1) {
    const o = original[i]!;
    const r = recovered[i + delay]!;
    const e = o - r;
    signal += o * o;
    noise += e * e;
  }
  if (noise === 0) return Infinity;
  if (signal === 0) return 0;
  return 10 * Math.log10(signal / noise);
}

/** Empirical QMF analysis+synthesis group delay for this implementation (samples). */
const QMF_GROUP_DELAY = 22;

function sine(hz: number, seconds: number, amp = 8000): Int16Array {
  const n = Math.round(G722_SAMPLE_RATE_HZ * seconds);
  // even length for clean pairing
  const len = n & ~1;
  const out = new Int16Array(len);
  for (let i = 0; i < len; i += 1) {
    out[i] = Math.round(amp * Math.sin((2 * Math.PI * hz * i) / G722_SAMPLE_RATE_HZ));
  }
  return out;
}

describe("G.722 API shape", () => {
  it("exports sample rate constant 16000", () => {
    expect(G722_SAMPLE_RATE_HZ).toBe(16_000);
  });

  it("encoder produces half the sample count in bytes", () => {
    const enc = createG722EncoderState();
    const pcm = new Int16Array(320); // 20 ms @ 16 kHz
    const bytes = encodeG722(enc, pcm);
    expect(bytes.length).toBe(160);
  });

  it("decoder produces 2 samples per G.722 byte", () => {
    const enc = createG722EncoderState();
    const dec = createG722DecoderState();
    const pcm = sine(1000, 0.02);
    const bytes = encodeG722(enc, pcm);
    const out = decodeG722(dec, bytes);
    expect(out.length).toBe(bytes.length * 2);
  });

  it("holds an odd trailing sample for the next encode call", () => {
    const enc = createG722EncoderState();
    const a = encodeG722(enc, new Int16Array([100, 200, 300]));
    expect(a.length).toBe(1); // one pair; 300 pending
    const b = encodeG722(enc, new Int16Array([400]));
    expect(b.length).toBe(1); // pending 300 + 400
  });
});

describe("G.722 round-trip (spec-implemented, NOT ITU-vector-certified)", () => {
  it("round-trips silence near zero after QMF settle", () => {
    const enc = createG722EncoderState();
    const dec = createG722DecoderState();
    // Warm-up: QMF needs history before settling
    const warm = new Int16Array(480);
    decodeG722(dec, encodeG722(enc, warm));
    const silence = new Int16Array(320);
    const recovered = decodeG722(dec, encodeG722(enc, silence));
    for (let i = 0; i < recovered.length; i += 1) {
      expect(Math.abs(recovered[i]!)).toBeLessThanOrEqual(64);
    }
  });

  it("round-trips 1 kHz tone with SNR ≥ 20 dB (after settle + QMF delay)", () => {
    const enc = createG722EncoderState();
    const dec = createG722DecoderState();
    const pcm = sine(1000, 0.25, 10000);
    const recovered = decodeG722(dec, encodeG722(enc, pcm));
    const snr = snrDb(pcm, recovered, QMF_GROUP_DELAY);
    expect(snr).toBeGreaterThanOrEqual(20);
  });

  it("round-trips multi-tone speech-like signal with SNR ≥ 18 dB", () => {
    const enc = createG722EncoderState();
    const dec = createG722DecoderState();
    const n = 1600; // 100 ms
    const pcm = new Int16Array(n);
    for (let i = 0; i < n; i += 1) {
      const t = i / G722_SAMPLE_RATE_HZ;
      pcm[i] = Math.round(
        6000 * Math.sin(2 * Math.PI * 300 * t) +
          4000 * Math.sin(2 * Math.PI * 900 * t) +
          2500 * Math.sin(2 * Math.PI * 1800 * t) +
          1500 * Math.sin(2 * Math.PI * 3200 * t),
      );
    }
    const recovered = decodeG722(dec, encodeG722(enc, pcm));
    const snr = snrDb(pcm, recovered, QMF_GROUP_DELAY);
    expect(snr).toBeGreaterThanOrEqual(18);
  });

  it("preserves sign of a positive then negative burst (aligned by QMF delay)", () => {
    const enc = createG722EncoderState();
    const dec = createG722DecoderState();
    decodeG722(dec, encodeG722(enc, new Int16Array(640)));
    const pos = new Int16Array(320).fill(8000);
    const neg = new Int16Array(320).fill(-8000);
    const rPos = decodeG722(dec, encodeG722(enc, pos));
    const rNeg = decodeG722(dec, encodeG722(enc, neg));
    // recovered[i + delay] ≈ input[i]; probe mid-burst after delay
    const mid = 160;
    expect(rPos[mid + QMF_GROUP_DELAY]!).toBeGreaterThan(0);
    expect(rNeg[mid + QMF_GROUP_DELAY]!).toBeLessThan(0);
  });

  it("known-answer: encoder is deterministic for a fixed impulse train", () => {
    const enc = createG722EncoderState();
    const pcm = new Int16Array(64);
    pcm[0] = 10000;
    pcm[1] = -10000;
    pcm[16] = 5000;
    const a = encodeG722(enc, pcm);
    const enc2 = createG722EncoderState();
    const b = encodeG722(enc2, pcm);
    expect(Array.from(a)).toEqual(Array.from(b));
    // non-trivial: not all zeros after impulse
    expect(a.some((v) => v !== 0)).toBe(true);
  });
});
