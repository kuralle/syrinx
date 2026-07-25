// SPDX-License-Identifier: MIT

import { buildSessionRecord } from "@kuralle-syrinx/browser-client/record";
import { encodeWav } from "@kuralle-syrinx/browser-client/turn-recorder";
import { describe, expect, it } from "vitest";

import { buildFixture, fixtureBaseName, fixtureBlockedReason, FIXTURE_FORMAT } from "./fixture-export";

const AT = "2026-07-26T09:15:30.123Z";

const recordWith = (msgs: readonly unknown[], wsUrl = "ws://127.0.0.1:4173/ws") =>
  buildSessionRecord(msgs.map((m, i) => ({ message: m as never, atMs: i })), { wsUrl });

const READY = {
  type: "ready",
  sessionId: "s-1",
  resumeWindowMs: 15_000,
  audio: {
    inputSampleRateHz: 16_000,
    outputSampleRateHz: 16_000,
    encoding: "pcm_s16le",
    channels: 1,
    targetFrameDurationMs: 20,
  },
};

const spokenTurn = () =>
  recordWith([
    READY,
    { type: "stt_output", turnId: "t1", transcript: "What is the application deadline?", confidence: 0.97 },
    { type: "agent_chunk", turnId: "t1", text: "It is March 1st." },
    { type: "turn_complete", turnId: "t1", transcript: "What is the application deadline?" },
  ]);

const build = (record = spokenTurn()) => {
  const turn = record.turns[0];
  if (!turn) throw new Error("fixture setup: no turn");
  return buildFixture({
    turn,
    config: record.config,
    wav: encodeWav(new Int16Array(16_000).fill(1000), 16_000),
    sampleRateHz: 16_000,
    durationMs: 1000,
    truncated: false,
    capturedAtIso: AT,
  });
};

describe("fixture export", () => {
  it("carries the capture config, not just the transcript", () => {
    // A fixture replayed under different conditions lies: 24kHz audio against a
    // 16kHz expectation transcribes differently and the agent gets the blame.
    const { sidecar } = build();
    expect(sidecar.format).toBe(FIXTURE_FORMAT);
    expect(sidecar.expectedTranscript).toBe("What is the application deadline?");
    expect(sidecar.capture).toMatchObject({
      wsUrl: "ws://127.0.0.1:4173/ws",
      inputSampleRateHz: 16_000,
      encoding: "pcm_s16le",
      targetFrameDurationMs: 20,
    });
    expect(sidecar.audio).toMatchObject({
      sampleRateHz: 16_000,
      channels: 1,
      encoding: "pcm_s16le",
      truncated: false,
    });
  });

  it("names the audio file the sidecar points at", () => {
    const fixture = build();
    expect(fixture.sidecar.audioFile).toBe(fixture.wavFileName);
    expect(fixture.wavFileName.endsWith(".wav")).toBe(true);
    expect(fixture.jsonFileName.endsWith(".json")).toBe(true);
    expect(fixture.wavFileName.slice(0, -4)).toBe(fixture.jsonFileName.slice(0, -5));
  });

  it("emits a WAV a decoder accepts, at the recorded rate", () => {
    const { wav } = build();
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe("WAVE");
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(22, true)).toBe(1);
  });

  it("names the file after what was said, so a folder of these is readable", () => {
    const record = spokenTurn();
    const turn = record.turns[0];
    expect(turn && fixtureBaseName(turn, AT)).toBe("what-is-the-application-deadline-2026-07-26_09-15-30");
  });

  it("falls back to the turn id when there is no transcript to name it after", () => {
    const record = recordWith([READY, { type: "agent_chunk", turnId: "t9", text: "hi" }]);
    const turn = record.turns[0];
    expect(turn && fixtureBaseName(turn, AT)).toMatch(/^turn-t9-/);
  });

  it("omits observed timings rather than writing zeroes when the backend sent none", () => {
    // The Workers path emits no metrics. A fixture claiming 0ms everywhere would
    // read as a zero-latency capture.
    expect(build().sidecar.observedTimings).toBeUndefined();
  });

  it("keeps observed timings when they exist", () => {
    const record = recordWith([
      READY,
      { type: "stt_output", turnId: "t1", transcript: "hi" },
      { type: "metrics", turnId: "t1", sttMs: 200, ttsTTFBMs: 400 },
    ]);
    const turn = record.turns[0];
    if (!turn) throw new Error("no turn");
    const fixture = buildFixture({
      turn,
      config: record.config,
      wav: encodeWav(new Int16Array(160), 16_000),
      sampleRateHz: 16_000,
      durationMs: 10,
      truncated: false,
      capturedAtIso: AT,
    });
    expect(fixture.sidecar.observedTimings).toMatchObject({ sttMs: 200, ttsTTFBMs: 400 });
  });

  it("round-trips as parseable JSON", () => {
    const fixture = build();
    expect(JSON.parse(fixture.json)).toEqual(fixture.sidecar);
  });

  it("says why a turn cannot be saved instead of just disabling", () => {
    const record = spokenTurn();
    const turn = record.turns[0];
    if (!turn) throw new Error("no turn");
    expect(fixtureBlockedReason(turn, true)).toBeUndefined();
    expect(fixtureBlockedReason(turn, false)).toMatch(/no recorded audio/i);

    const untranscribed = recordWith([READY, { type: "agent_chunk", turnId: "t2", text: "hi" }]).turns[0];
    if (!untranscribed) throw new Error("no turn");
    expect(fixtureBlockedReason(untranscribed, true)).toMatch(/never transcribed/i);
  });

  it("records that the tail was dropped, so a short fixture is not mistaken for a short turn", () => {
    const record = spokenTurn();
    const turn = record.turns[0];
    if (!turn) throw new Error("no turn");
    const fixture = buildFixture({
      turn,
      config: record.config,
      wav: encodeWav(new Int16Array(160), 16_000),
      sampleRateHz: 16_000,
      durationMs: 10,
      truncated: true,
      capturedAtIso: AT,
    });
    expect(fixture.sidecar.audio.truncated).toBe(true);
  });
});
