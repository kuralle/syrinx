// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { encodeWav, TurnAudioRecorder } from "./turn-recorder.js";

/** Decode a WAV the way a consumer would, so the test proves the bytes, not our own encoder. */
function decodeWav(bytes: Uint8Array): { sampleRateHz: number; channels: number; bits: number; samples: Int16Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number, length: number): string =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));
  expect(tag(0, 4)).toBe("RIFF");
  expect(tag(8, 4)).toBe("WAVE");
  expect(tag(12, 4)).toBe("fmt ");
  expect(tag(36, 4)).toBe("data");
  expect(view.getUint32(4, true)).toBe(bytes.byteLength - 8);
  const dataBytes = view.getUint32(40, true);
  expect(44 + dataBytes).toBe(bytes.byteLength);
  const samples = new Int16Array(dataBytes / 2);
  for (let i = 0; i < samples.length; i += 1) samples[i] = view.getInt16(44 + i * 2, true);
  return {
    sampleRateHz: view.getUint32(24, true),
    channels: view.getUint16(22, true),
    bits: view.getUint16(34, true),
    samples,
  };
}

const frame = (value: number, length = 320): Int16Array => new Int16Array(length).fill(value);

const ready = (hz: number) => ({ type: "ready" as const, audio: { inputSampleRateHz: hz } });

/** Drive one whole turn: pre-speech silence, speech, then the boundary that names the turn. */
function runTurn(rec: TurnAudioRecorder, turnId: string, value: number, frames = 5): void {
  rec.onMessage({ type: "speech_started", turnId });
  for (let i = 0; i < frames; i += 1) rec.pushFrame(frame(value));
  rec.onMessage({ type: "turn_complete", turnId, transcript: "x" });
}

describe("encodeWav", () => {
  it("writes a header a decoder accepts, little-endian regardless of host", () => {
    const wav = encodeWav(Int16Array.from([0, 1, -1, 32767, -32768]), 16000);
    const decoded = decodeWav(wav);
    expect(decoded).toMatchObject({ sampleRateHz: 16000, channels: 1, bits: 16 });
    expect([...decoded.samples]).toEqual([0, 1, -1, 32767, -32768]);
  });

  it("refuses an invalid sample rate rather than writing an undecodable file", () => {
    expect(() => encodeWav(new Int16Array(4), 0)).toThrow(/invalid sampleRateHz/);
  });
});

describe("TurnAudioRecorder", () => {
  it("yields one decodable WAV per turn at the negotiated rate", () => {
    const rec = new TurnAudioRecorder();
    rec.onMessage(ready(24000));
    runTurn(rec, "t1", 100);
    runTurn(rec, "t2", 200);
    runTurn(rec, "t3", 300);

    expect(rec.list().map((t) => t.turnId)).toEqual(["t1", "t2", "t3"]);
    for (const [turnId, value] of [["t1", 100], ["t2", 200], ["t3", 300]] as const) {
      const wav = rec.getWav(turnId);
      expect(wav, `${turnId} should have audio`).toBeDefined();
      const decoded = decodeWav(wav as Uint8Array);
      // The negotiated rate from `ready`, not the 16k default — a fixture written at the
      // wrong rate transcribes as gibberish.
      expect(decoded.sampleRateHz).toBe(24000);
      expect(decoded.samples.length).toBe(5 * 320);
      expect(decoded.samples[0]).toBe(value);
    }
  });

  it("keeps the pre-roll so the speech onset is not clipped", () => {
    const rec = new TurnAudioRecorder({ preRollMs: 20 });
    rec.onMessage(ready(16000));
    // 16000 Hz * 20ms = 320 samples of pre-roll retained.
    rec.pushFrame(frame(7, 320));
    rec.onMessage({ type: "speech_started", turnId: "t1" });
    rec.pushFrame(frame(9, 320));
    rec.onMessage({ type: "turn_complete", turnId: "t1", transcript: "x" });

    const decoded = decodeWav(rec.getWav("t1") as Uint8Array);
    expect(decoded.samples.length).toBe(640);
    expect(decoded.samples[0]).toBe(7); // onset present
    expect(decoded.samples[320]).toBe(9);
  });

  it("attributes a turn whose id only arrives on the closing message", () => {
    const rec = new TurnAudioRecorder();
    rec.onMessage(ready(16000));
    rec.onMessage({ type: "speech_started" }); // no turnId yet
    rec.pushFrame(frame(5));
    rec.onMessage({ type: "speech_ended" }); // still none — must not be lost
    rec.onMessage({ type: "stt_output", turnId: "late", transcript: "hi" });
    expect(rec.getWav("late")).toBeDefined();
  });

  it("evicts oldest audio past maxTurns and does not grow unbounded", () => {
    const rec = new TurnAudioRecorder({ maxTurns: 3 });
    rec.onMessage(ready(16000));
    for (let i = 0; i < 25; i += 1) runTurn(rec, `t${String(i)}`, i + 1);

    expect(rec.list()).toHaveLength(3);
    expect(rec.list().map((t) => t.turnId)).toEqual(["t22", "t23", "t24"]);
    expect(rec.getWav("t0")).toBeUndefined(); // evicted, reported as absent not as silence
    // 3 turns * 5 frames * 320 samples * 2 bytes — flat regardless of session length.
    expect(rec.retainedBytes()).toBe(3 * 5 * 320 * 2);
  });

  it("caps a single runaway turn and says the tail was dropped", () => {
    const rec = new TurnAudioRecorder({ maxTurnMs: 100 }); // 1600 samples at 16k
    rec.onMessage(ready(16000));
    rec.onMessage({ type: "speech_started", turnId: "stuck" });
    for (let i = 0; i < 100; i += 1) rec.pushFrame(frame(1, 320));
    rec.onMessage({ type: "turn_complete", turnId: "stuck", transcript: "x" });

    const entry = rec.list()[0];
    expect(entry?.truncated).toBe(true);
    expect(entry?.byteLength).toBeLessThanOrEqual(1600 * 2 + 320 * 2);
  });

  it("reports duration from the sample count, not from wall clock", () => {
    const rec = new TurnAudioRecorder();
    rec.onMessage(ready(16000));
    runTurn(rec, "t1", 1, 50); // 50 * 320 = 16000 samples = exactly 1s
    expect(rec.list()[0]?.durationMs).toBe(1000);
  });

  it("reset drops every retained blob", () => {
    const rec = new TurnAudioRecorder();
    rec.onMessage(ready(16000));
    runTurn(rec, "t1", 1);
    rec.reset();
    expect(rec.list()).toHaveLength(0);
    expect(rec.retainedBytes()).toBe(0);
  });
});
