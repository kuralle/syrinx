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

export function resamplePcm16(
  input: Int16Array,
  sourceSampleRateHz: number,
  targetSampleRateHz: number,
): Int16Array {
  if (input.length === 0) return new Int16Array(0);
  if (sourceSampleRateHz === targetSampleRateHz) return input;

  const outputLength = Math.max(1, Math.round((input.length * targetSampleRateHz) / sourceSampleRateHz));
  const ratio = sourceSampleRateHz / targetSampleRateHz;

  if (ratio <= 1) {
    // Upsample: linear interpolation is alias-free (no folding risk on expansion).
    return linearInterpolate(input, outputLength, ratio);
  }

  // Downsample: apply anti-alias FIR at 0.45 × targetRate before decimation.
  const cutoffNormalized = (0.45 * targetSampleRateHz) / sourceSampleRateHz;
  const fir = getLowPassFir(cutoffNormalized);
  return firDecimate(input, outputLength, ratio, fir);
}
