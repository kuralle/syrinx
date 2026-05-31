// SPDX-License-Identifier: MIT

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

export function decodeMuLawToPcm16(input: Uint8Array): Int16Array {
  const output = new Int16Array(input.byteLength);
  for (let i = 0; i < input.byteLength; i += 1) {
    const ulaw = (~input[i]!) & 0xff;
    const sign = ulaw & 0x80;
    const exponent = (ulaw >> 4) & 0x07;
    const mantissa = ulaw & 0x0f;
    let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
    sample -= MULAW_BIAS;
    output[i] = sign ? -sample : sample;
  }
  return output;
}

export function encodePcm16ToMuLaw(input: Int16Array): Uint8Array {
  const output = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    output[i] = encodeSample(input[i]!);
  }
  return output;
}

function encodeSample(sample: number): number {
  let sign = 0;
  let magnitude = sample;
  if (magnitude < 0) {
    sign = 0x80;
    magnitude = -magnitude;
  }
  magnitude = Math.min(magnitude, MULAW_CLIP) + MULAW_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (magnitude & mask) === 0 && exponent > 0; mask >>= 1) {
    exponent -= 1;
  }
  const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}
