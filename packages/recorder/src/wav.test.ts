// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { interleaveStereoPcm16, pcm16ToWav } from "./wav.js";

describe("pcm16ToWav", () => {
  it("writes a canonical 44-byte RIFF/PCM header for the given rate and channels", () => {
    const pcm = new Uint8Array([1, 2, 3, 4]); // 2 mono samples
    const wav = pcm16ToWav(pcm, 16000, 1);
    expect(wav.byteLength).toBe(44 + 4);
    const view = new DataView(wav.buffer);
    expect(String.fromCharCode(wav[0]!, wav[1]!, wav[2]!, wav[3]!)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + 4); // chunk size
    expect(String.fromCharCode(wav[8]!, wav[9]!, wav[10]!, wav[11]!)).toBe("WAVE");
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // channels
    expect(view.getUint32(24, true)).toBe(16000); // sample rate
    expect(view.getUint16(32, true)).toBe(2); // blockAlign = channels * 2
    expect(view.getUint32(40, true)).toBe(4); // data size
    expect([...wav.subarray(44)]).toEqual([1, 2, 3, 4]);
  });

  it("sets stereo blockAlign and byteRate", () => {
    const view = new DataView(pcm16ToWav(new Uint8Array(8), 24000, 2).buffer);
    expect(view.getUint16(32, true)).toBe(4); // 2ch * 2 bytes
    expect(view.getUint32(28, true)).toBe(24000 * 4); // byteRate
  });
});

describe("interleaveStereoPcm16", () => {
  it("interleaves L/R frames and pads the shorter stream with silence", () => {
    const left = new Uint8Array([0x10, 0x00, 0x20, 0x00]); // samples 16, 32
    const right = new Uint8Array([0x01, 0x00]); // sample 1, then padded
    const out = interleaveStereoPcm16(left, right);
    const view = new DataView(out.buffer);
    expect(out.byteLength).toBe(2 * 4); // 2 frames × (2ch × 2 bytes)
    expect(view.getInt16(0, true)).toBe(16); // L0
    expect(view.getInt16(2, true)).toBe(1); // R0
    expect(view.getInt16(4, true)).toBe(32); // L1
    expect(view.getInt16(6, true)).toBe(0); // R1 padded
  });
});
