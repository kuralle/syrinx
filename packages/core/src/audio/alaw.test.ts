// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { decodeALawToPcm16, encodePcm16ToALaw } from "./alaw.js";

// Known G.711 A-law reference pairs (PCM16 sample → A-law byte).
// Values match the standard even-bit-inversion A-law tables used by telephony stacks.
const KNOWN_ENCODE: ReadonlyArray<readonly [number, number]> = [
  [0, 0xd5],
  [8, 0xd5],
  [16, 0xd4],
  [128, 0xdd],
  [256, 0xc5],
  [512, 0xf5],
  [1024, 0xe5],
  [2048, 0x95],
  [4096, 0x85],
  [8192, 0xb5],
  [16384, 0xa5],
  [-8, 0x55],
  [-128, 0x5d],
  [-1024, 0x65],
  [-8192, 0x35],
];

describe("A-law encode — known values", () => {
  for (const [pcm, alaw] of KNOWN_ENCODE) {
    it(`encodes PCM ${pcm} → 0x${alaw.toString(16)}`, () => {
      const encoded = encodePcm16ToALaw(new Int16Array([pcm]));
      expect(encoded[0]).toBe(alaw);
    });
  }
});

describe("A-law decode — inverse of known codes", () => {
  it("decodes silence code 0xD5 near zero", () => {
    const decoded = decodeALawToPcm16(new Uint8Array([0xd5]));
    expect(Math.abs(decoded[0]!)).toBeLessThanOrEqual(16);
  });

  it("preserves sign for positive and negative codes", () => {
    // 0xA5 = encode(+16384), 0x25 = encode(-16384)
    const pos = decodeALawToPcm16(new Uint8Array([0xa5]));
    const neg = decodeALawToPcm16(new Uint8Array([0x25]));
    expect(pos[0]!).toBeGreaterThan(0);
    expect(neg[0]!).toBeLessThan(0);
  });

  it("round-trips known encode pairs within A-law quantization", () => {
    for (const [pcm] of KNOWN_ENCODE) {
      const encoded = encodePcm16ToALaw(new Int16Array([pcm]));
      const decoded = decodeALawToPcm16(encoded);
      // A-law step size grows with magnitude; allow 1/16 of |pcm| + 16 floor.
      const tol = Math.max(16, Math.floor(Math.abs(pcm) / 16));
      expect(Math.abs(decoded[0]! - pcm)).toBeLessThanOrEqual(tol);
    }
  });
});

describe("A-law round-trip", () => {
  it("round-trips silence exactly within quantization", () => {
    const silence = new Int16Array(160);
    const decoded = decodeALawToPcm16(encodePcm16ToALaw(silence));
    for (let i = 0; i < decoded.length; i += 1) {
      expect(Math.abs(decoded[i]!)).toBeLessThanOrEqual(16);
    }
  });

  it("round-trips a 1 kHz sine within A-law quantization tolerance", () => {
    const N = 160;
    const input = new Int16Array(N);
    for (let i = 0; i < N; i += 1) {
      input[i] = Math.round(16000 * Math.sin((2 * Math.PI * 1000 * i) / 8000));
    }
    const decoded = decodeALawToPcm16(encodePcm16ToALaw(input));
    for (let i = 0; i < N; i += 1) {
      expect(Math.abs(decoded[i]! - input[i]!)).toBeLessThanOrEqual(1638);
    }
  });

  it("preserves sign", () => {
    const pos = decodeALawToPcm16(encodePcm16ToALaw(new Int16Array([10000])));
    const neg = decodeALawToPcm16(encodePcm16ToALaw(new Int16Array([-10000])));
    expect(pos[0]!).toBeGreaterThan(0);
    expect(neg[0]!).toBeLessThan(0);
  });
});
