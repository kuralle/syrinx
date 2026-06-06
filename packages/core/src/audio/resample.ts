// SPDX-License-Identifier: MIT

// Windowed-sinc FIR low-pass filter for anti-alias downsampling.
// Hann window, 127 taps — gives ~44 dB min stopband attenuation, sufficient for
// the ≥40 dB alias-suppression requirement (F3). A polyphase structure would be
// faster but this direct-form is simpler to audit and correct for our frame sizes.
const FIR_TAPS = 127;

function buildLowPassFir(cutoffNormalized: number): Float64Array {
  // cutoffNormalized: fraction of the source sample rate (0 = DC, 0.5 = Nyquist).
  const M = FIR_TAPS - 1; // filter order (126 for 127 taps)
  const h = new Float64Array(FIR_TAPS);
  let sum = 0;
  for (let n = 0; n < FIR_TAPS; n += 1) {
    const delay = n - M / 2; // centered delay: -63..0..63
    const sinc =
      delay === 0
        ? 2 * cutoffNormalized
        : Math.sin(2 * Math.PI * cutoffNormalized * delay) / (Math.PI * delay);
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / M);
    h[n] = sinc * hann;
    sum += h[n]!;
  }
  // Normalize for unity DC gain.
  for (let n = 0; n < FIR_TAPS; n += 1) {
    h[n]! /= sum;
  }
  return h;
}

// The FIR depends only on the (source,target) rate pair via its cutoff, which is
// constant per connection. resamplePcm16 runs per audio chunk in the hot path, so
// cache the kernel instead of rebuilding 127 sinc·Hann taps on every call. Bounded:
// real deployments use a handful of distinct rate pairs (24k/16k→8k, 48k→16k, …).
const firCache = new Map<number, Float64Array>();

function getLowPassFir(cutoffNormalized: number): Float64Array {
  const key = Math.round(cutoffNormalized * 1e6);
  let fir = firCache.get(key);
  if (fir === undefined) {
    fir = buildLowPassFir(cutoffNormalized);
    firCache.set(key, fir);
  }
  return fir;
}

// Evaluate the symmetric FIR centered at each decimated output position.
// Using the symmetric (zero-delay) formula avoids a group-delay shift at the
// cost of needing halfTaps future samples — which are available because we
// process a complete chunk at once.  Edge samples (first / last halfTaps/ratio
// output samples) use only the available taps; their amplitude tapers due to
// the missing context, which is the accepted trade-off for stateless chunk
// processing.
function firDecimate(input: Int16Array, outputLength: number, ratio: number, fir: Float64Array): Int16Array {
  const M = fir.length;
  const halfTaps = Math.floor(M / 2); // 63 for 127-tap filter
  const output = new Int16Array(outputLength);
  for (let m = 0; m < outputLength; m += 1) {
    const n0 = Math.round(m * ratio); // nearest source position for output m
    let acc = 0;
    // Centered: h[0] multiplies x[n0+halfTaps], h[halfTaps] multiplies x[n0],
    // h[M-1] multiplies x[n0-halfTaps].
    for (let k = 0; k < M; k += 1) {
      const srcIdx = n0 - k + halfTaps;
      if (srcIdx >= 0 && srcIdx < input.length) {
        acc += fir[k]! * input[srcIdx]!;
      }
    }
    // Clamp to Int16 range; FIR sum can slightly exceed due to rounding.
    output[m] = Math.max(-32768, Math.min(32767, Math.round(acc)));
  }
  return output;
}

function linearInterpolate(input: Int16Array, outputLength: number, ratio: number): Int16Array {
  const output = new Int16Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const pos = i * ratio;
    const lo = Math.floor(pos);
    const hi = Math.min(input.length - 1, lo + 1);
    const frac = pos - lo;
    output[i] = Math.round(input[lo]! * (1 - frac) + input[hi]! * frac);
  }
  return output;
}

function outputLengthFor(inputLength: number, sourceSampleRateHz: number, targetSampleRateHz: number): number {
  return Math.max(1, Math.round((inputLength * targetSampleRateHz) / sourceSampleRateHz));
}

export function resamplePcm16(
  input: Int16Array,
  sourceSampleRateHz: number,
  targetSampleRateHz: number,
): Int16Array {
  if (input.length === 0) return new Int16Array(0);
  if (sourceSampleRateHz === targetSampleRateHz) return input;

  const outputLength = outputLengthFor(input.length, sourceSampleRateHz, targetSampleRateHz);
  const ratio = sourceSampleRateHz / targetSampleRateHz;

  if (ratio <= 1) {
    return linearInterpolate(input, outputLength, ratio);
  }

  const cutoffNormalized = (0.45 * targetSampleRateHz) / sourceSampleRateHz;
  const fir = getLowPassFir(cutoffNormalized);
  return firDecimate(input, outputLength, ratio, fir);
}

export class StreamingPcm16Resampler {
  private history = new Int16Array(0);
  private readonly ratio: number;
  private readonly fir: Float64Array | null;
  private readonly sourceSampleRateHz: number;
  private readonly targetSampleRateHz: number;

  constructor(sourceSampleRateHz: number, targetSampleRateHz: number) {
    this.sourceSampleRateHz = sourceSampleRateHz;
    this.targetSampleRateHz = targetSampleRateHz;
    this.ratio = sourceSampleRateHz / targetSampleRateHz;
    if (this.ratio > 1) {
      const cutoffNormalized = (0.45 * targetSampleRateHz) / sourceSampleRateHz;
      this.fir = getLowPassFir(cutoffNormalized);
    } else {
      this.fir = null;
    }
  }

  process(input: Int16Array): Int16Array {
    if (input.length === 0) return new Int16Array(0);
    if (this.sourceSampleRateHz === this.targetSampleRateHz) return input;

    if (this.ratio <= 1 || this.fir === null) {
      const outputLength = outputLengthFor(input.length, this.sourceSampleRateHz, this.targetSampleRateHz);
      return linearInterpolate(input, outputLength, this.ratio);
    }

    const historyLength = this.history.length;
    const combined = new Int16Array(historyLength + input.length);
    combined.set(this.history, 0);
    combined.set(input, historyLength);

    const fullOutputLength = outputLengthFor(combined.length, this.sourceSampleRateHz, this.targetSampleRateHz);
    const fullOutput = firDecimate(combined, fullOutputLength, this.ratio, this.fir);
    let firstNewOutput = 0;
    if (historyLength > 0) {
      while (firstNewOutput < fullOutput.length) {
        const centerInputIndex = Math.round(firstNewOutput * this.ratio);
        if (centerInputIndex >= historyLength) break;
        firstNewOutput += 1;
      }
    }
    const output = fullOutput.subarray(firstNewOutput);

    const keepHistory = Math.min(FIR_TAPS - 1, combined.length);
    this.history = combined.subarray(combined.length - keepHistory);
    return output;
  }
}

export function resamplePcm16Streaming(
  resamplers: Map<string, StreamingPcm16Resampler>,
  input: Int16Array,
  sourceSampleRateHz: number,
  targetSampleRateHz: number,
): Int16Array {
  if (input.length === 0) return new Int16Array(0);
  if (sourceSampleRateHz === targetSampleRateHz) return input;
  const key = `${String(sourceSampleRateHz)}->${String(targetSampleRateHz)}`;
  let resampler = resamplers.get(key);
  if (!resampler) {
    resampler = new StreamingPcm16Resampler(sourceSampleRateHz, targetSampleRateHz);
    resamplers.set(key, resampler);
  }
  return resampler.process(input);
}
