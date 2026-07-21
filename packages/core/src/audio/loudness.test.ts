// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { createLoudnessState, normalizeLoudness, type LoudnessConfig } from "./loudness.js";

function rms(pcm: Int16Array): number {
  let sumSquares = 0;
  for (const sample of pcm) sumSquares += sample * sample;
  return Math.sqrt(sumSquares / pcm.length);
}

function constantPcm(value: number, length = 320): Int16Array {
  return new Int16Array(length).fill(value);
}

describe("normalizeLoudness", () => {
  it("raises quiet PCM and lowers loud PCM toward the target", () => {
    const config: LoudnessConfig = { targetRms: 8000 };
    const quiet = normalizeLoudness(constantPcm(1000), createLoudnessState(), config);
    const loud = normalizeLoudness(constantPcm(24000), createLoudnessState(), config);

    expect(rms(quiet)).toBeGreaterThan(1000);
    expect(rms(loud)).toBeLessThan(24000);
    expect(Math.max(...quiet)).toBeLessThanOrEqual(32767);
    expect(Math.min(...quiet)).toBeGreaterThanOrEqual(-32768);
    expect(Math.max(...loud)).toBeLessThanOrEqual(32767);
    expect(Math.min(...loud)).toBeGreaterThanOrEqual(-32768);
  });

  it("converges different input levels into the same output band", () => {
    const config: LoudnessConfig = { targetRms: 8000 };
    const quietState = createLoudnessState();
    const loudState = createLoudnessState();
    let quietRms = 0;
    let loudRms = 0;

    for (let i = 0; i < 12; i += 1) {
      quietRms = rms(normalizeLoudness(constantPcm(2000), quietState, config));
      loudRms = rms(normalizeLoudness(constantPcm(24000), loudState, config));
    }

    expect(Math.abs(quietRms - loudRms)).toBeLessThanOrEqual(100);
    expect(Math.abs(quietRms - config.targetRms)).toBeLessThanOrEqual(100);
  });

  it("uses a soft ceiling for full-scale input without clipping or wrapping", () => {
    const output = normalizeLoudness(
      new Int16Array([32767, -32768, 32767, -32768]),
      createLoudnessState(),
      { targetRms: 32767 },
    );

    expect(Math.max(...output)).toBeLessThan(32767);
    expect(Math.min(...output)).toBeGreaterThan(-32768);
    expect(Math.max(...output)).toBeGreaterThan(0);
    expect(Math.min(...output)).toBeLessThan(0);
  });
});
