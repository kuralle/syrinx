// SPDX-License-Identifier: MIT
//
// ITU-T G.711 A-law (PCMA). Pure TypedArray — Workers-safe (no Buffer/node:).
// Unit-verified against known A-law encode/decode values + round-trip fidelity.
// Unverified against a live carrier trunk negotiation.

const ALAW_CLIP = 32635;
const ALAW_BIAS = 0x55;

export function decodeALawToPcm16(input: Uint8Array): Int16Array {
  const output = new Int16Array(input.byteLength);
  for (let i = 0; i < input.byteLength; i += 1) {
    const alaw = input[i]! ^ ALAW_BIAS;
    // A-law sign bit is inverted vs μ-law: 0x80 means positive.
    const positive = (alaw & 0x80) !== 0;
    const exponent = (alaw >> 4) & 0x07;
    const mantissa = alaw & 0x0f;
    let sample: number;
    if (exponent === 0) {
      sample = (mantissa << 4) + 8;
    } else {
      sample = ((mantissa << 4) + 0x108) << (exponent - 1);
    }
    output[i] = positive ? sample : -sample;
  }
  return output;
}

export function encodePcm16ToALaw(input: Int16Array): Uint8Array {
  const output = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    output[i] = encodeSample(input[i]!);
  }
  return output;
}

function encodeSample(sample: number): number {
  // A-law: sign bit 0x80 = positive (opposite of μ-law).
  let sign = 0x80;
  let magnitude = sample;
  if (magnitude < 0) {
    sign = 0;
    magnitude = -magnitude;
  }
  if (magnitude > ALAW_CLIP) magnitude = ALAW_CLIP;

  let exponent = 7;
  for (let mask = 0x4000; (magnitude & mask) === 0 && exponent > 0; mask >>= 1) {
    exponent -= 1;
  }
  const mantissa =
    exponent === 0
      ? (magnitude >> 4) & 0x0f
      : (magnitude >> (exponent + 3)) & 0x0f;
  return (sign | (exponent << 4) | mantissa) ^ ALAW_BIAS;
}
