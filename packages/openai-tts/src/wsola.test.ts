// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { WsolaTimeStretch } from "./wsola.js";

const SR = 24_000;
const FREQ_HZ = 220;
const DURATION_S = 1;

function sinePcm16(sampleRateHz: number, freqHz: number, durationS: number): Int16Array {
  const n = Math.round(sampleRateHz * durationS);
  const out = new Int16Array(n);
  const amp = 16000;
  for (let i = 0; i < n; i++) {
    out[i] = Math.round(amp * Math.sin((2 * Math.PI * freqHz * i) / sampleRateHz));
  }
  return out;
}

/** Mean period (samples) between successive rising zero-crossings. */
function meanRisingZeroCrossingPeriod(samples: Int16Array): number {
  const crossings: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1]!;
    const cur = samples[i]!;
    if (prev < 0 && cur >= 0) {
      // Linear interpolate fractional index
      const frac = prev === cur ? 0 : prev / (prev - cur);
      crossings.push(i - 1 + frac);
    }
  }
  if (crossings.length < 2) {
    throw new Error(`too few zero-crossings: ${String(crossings.length)}`);
  }
  let sum = 0;
  for (let i = 1; i < crossings.length; i++) {
    sum += crossings[i]! - crossings[i - 1]!;
  }
  return sum / (crossings.length - 1);
}

function stretchAll(tempo: number, input: Int16Array, sampleRateHz = SR): Int16Array {
  const s = new WsolaTimeStretch(tempo, sampleRateHz);
  const a = s.process(input);
  const b = s.flush();
  const out = new Int16Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function stretchChunked(tempo: number, input: Int16Array, chunkSize: number, sampleRateHz = SR): Int16Array {
  const s = new WsolaTimeStretch(tempo, sampleRateHz);
  const parts: Int16Array[] = [];
  for (let i = 0; i < input.length; i += chunkSize) {
    const chunk = input.subarray(i, Math.min(i + chunkSize, input.length));
    const out = s.process(chunk);
    if (out.length > 0) parts.push(out);
  }
  const tail = s.flush();
  if (tail.length > 0) parts.push(tail);
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Int16Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

describe("WsolaTimeStretch", () => {
  const input = sinePcm16(SR, FREQ_HZ, DURATION_S);
  const frame = Math.round(0.03 * SR);

  it("length scaling: tempo=0.9 lengthens output ≈ input/tempo (±1 frame)", () => {
    const out = stretchAll(0.9, input);
    const expected = input.length / 0.9;
    expect(Math.abs(out.length - expected)).toBeLessThanOrEqual(frame);
  });

  it("length scaling: tempo=1.2 shortens output ≈ input/tempo (±1 frame)", () => {
    const out = stretchAll(1.2, input);
    const expected = input.length / 1.2;
    expect(Math.abs(out.length - expected)).toBeLessThanOrEqual(frame);
  });

  it("pitch preserved: tempo=0.9 zero-crossing period matches input within 5%", () => {
    const out = stretchAll(0.9, input);
    // Skip a short edge region where OLA windowing is incomplete
    const skip = frame;
    const inPeriod = meanRisingZeroCrossingPeriod(input.subarray(skip, input.length - skip));
    const outPeriod = meanRisingZeroCrossingPeriod(out.subarray(skip, out.length - skip));
    const relErr = Math.abs(outPeriod - inPeriod) / inPeriod;
    expect(relErr).toBeLessThanOrEqual(0.05);
  });

  it("passthrough: tempo=1.0 returns input samples unchanged", () => {
    const s = new WsolaTimeStretch(1.0, SR);
    const out = s.process(input);
    expect(out.length).toBe(input.length);
    expect(out).toBe(input); // same reference — zero-cost passthrough
    for (let i = 0; i < input.length; i++) {
      expect(out[i]).toBe(input[i]);
    }
    const tail = s.flush();
    expect(tail.length).toBe(0);
  });

  it("streaming invariance: one chunk vs many small chunks → same total length (±1 frame)", () => {
    const one = stretchAll(0.9, input);
    const many = stretchChunked(0.9, input, 64);
    expect(Math.abs(one.length - many.length)).toBeLessThanOrEqual(frame);
  });
});
