// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { buildSessionRecord, type TurnRecord } from "./session-record.js";
import { buildTurnTimeline, buildTimelines, endpointingMarker, FAST_TURN_FLOOR_MS } from "./turn-timeline.js";

const turnWith = (timings: TurnRecord["timings"]): TurnRecord => ({
  turnId: "t1",
  startedAtMs: 0,
  events: [],
  agentText: "",
  toolCalls: [],
  ttsAudioBytes: 0,
  errors: [],
  complete: true,
  droppedEvents: 0,
  ...(timings ? { timings } : {}),
});

describe("turn timeline — segments", () => {
  it("derives consecutive segments from the marks", () => {
    const tl = buildTurnTimeline(
      turnWith({ speechEndMs: 1000, textReadyMs: 1300, firstAudioByteMs: 2500, firstAudioPlayedMs: 2700, lastAudioPlayedMs: 6300, e2eMs: 5300 }),
    );
    expect(tl.segments.map((s) => [s.label, s.durationMs])).toEqual([
      ["Deciding you're done, transcribing, and thinking", 300],
      ["Voice (to first audio)", 1200],
      ["First audio out", 200],
      ["Agent speaking", 3600],
    ]);
    expect(tl.totalMs).toBe(5300);
  });

  it("starts each segment where the previous ended", () => {
    const tl = buildTurnTimeline(
      turnWith({ speechEndMs: 100, textReadyMs: 200, firstAudioByteMs: 500 }),
    );
    expect(tl.segments.map((s) => s.startMs)).toEqual([0, 100]);
  });

  it("marks the longest segment as slowest — where the time actually went", () => {
    const tl = buildTurnTimeline(
      turnWith({ speechEndMs: 0, textReadyMs: 100, firstAudioByteMs: 2000, firstAudioPlayedMs: 2100 }),
    );
    expect(tl.segments.filter((s) => s.slowest).map((s) => s.label)).toEqual(["Voice (to first audio)"]);
  });

  it("uses plain language, never packet names", () => {
    const tl = buildTurnTimeline(turnWith({ speechEndMs: 0, textReadyMs: 100 }));
    const labels = tl.segments.map((s) => s.label).join(" ");
    expect(labels).not.toMatch(/eos|stt_|tts_|turn_complete|packet/i);
    expect(labels).toMatch(/deciding you're done/i);
  });
});

describe("turn timeline — missing data is stated, not faked", () => {
  it("reports no-metrics rather than a zero-length lane", () => {
    // The Workers path emits no `metrics` (LDT-18). An empty lane would read as
    // a zero-latency turn, which is the opposite of the truth.
    const tl = buildTurnTimeline(turnWith(undefined));
    expect(tl.unavailable).toBe("no-metrics");
    expect(tl.segments).toHaveLength(0);
  });

  it("reports insufficient-marks when only one mark arrived", () => {
    const tl = buildTurnTimeline(turnWith({ speechEndMs: 100, e2eMs: 900 }));
    expect(tl.unavailable).toBe("insufficient-marks");
    expect(tl.totalMs).toBe(900); // still report what is known
  });

  it("collapses a missing middle mark without corrupting neighbours", () => {
    const tl = buildTurnTimeline(
      turnWith({ speechEndMs: 0, firstAudioByteMs: 1000, lastAudioPlayedMs: 3000 }),
    );
    expect(tl.segments.map((s) => [s.label, s.durationMs])).toEqual([
      ["Voice (to first audio)", 1000],
      ["Agent speaking", 2000],
    ]);
  });

  it("never produces a negative duration from out-of-order marks", () => {
    const tl = buildTurnTimeline(turnWith({ speechEndMs: 1000, textReadyMs: 400 }));
    expect(tl.segments[0]?.durationMs).toBe(0);
  });
});

describe("turn timeline — the fast-turn floor", () => {
  it("flags an implausibly fast reply instead of celebrating it", () => {
    // 480ms is not "fast" — the endpointer fired while the caller was still talking.
    const tl = buildTurnTimeline(turnWith({ speechEndMs: 0, textReadyMs: 60, firstAudioByteMs: 400, e2eMs: 480 }));
    expect(tl.suspiciouslyFast).toEqual({ totalMs: 480, floorMs: FAST_TURN_FLOOR_MS });
  });

  it("does not flag a normal turn", () => {
    const tl = buildTurnTimeline(turnWith({ speechEndMs: 0, textReadyMs: 300, firstAudioByteMs: 1500, e2eMs: 2000 }));
    expect(tl.suspiciouslyFast).toBeUndefined();
  });

  it("does not flag a turn with no measurable total", () => {
    expect(buildTurnTimeline(turnWith({ speechEndMs: 0, textReadyMs: 0, e2eMs: 0 })).suspiciouslyFast).toBeUndefined();
  });
});

describe("turn timeline — from a real recorded session", () => {
  it("builds one lane per turn off a SessionRecord", () => {
    const rec = buildSessionRecord([
      { message: { type: "agent_chunk", turnId: "t1", text: "a" } as never, atMs: 0 },
      { message: { type: "metrics", turnId: "t1", speechEndMs: 0, textReadyMs: 200, firstAudioByteMs: 900, e2eMs: 1100 } as never, atMs: 1 },
      { message: { type: "agent_chunk", turnId: "t2", text: "b" } as never, atMs: 2 },
    ]);
    const tls = buildTimelines(rec.turns);
    expect(tls).toHaveLength(2);
    expect(tls[0]?.segments).toHaveLength(2);
    expect(tls[1]?.unavailable).toBe("no-metrics"); // t2 never got metrics
  });
});

describe("turn timeline — endpointing marker", () => {
  it("names the owner in plain language, never the raw enum value", () => {
    expect(endpointingMarker("provider_stt", "end_of_speech").text).toMatch(/speech-to-text provider/i);
    expect(endpointingMarker("smart_turn", "end_of_speech").text).toMatch(/smart turn/i);
    // "timer" covers both a realtime front and a session timer fallback, so the
    // label stays honest for either — never assumes the realtime model specifically.
    expect(endpointingMarker("timer", "end_of_speech").text).toMatch(/timer/i);
    // No packet/message names leak into user-facing text.
    for (const owner of ["provider_stt", "smart_turn", "timer"] as const) {
      expect(endpointingMarker(owner, "end_of_speech").text).not.toMatch(/provider_stt|smart_turn|eos\.turn/);
    }
  });

  it("says force-finalized was a timeout, not a natural endpoint", () => {
    const m = endpointingMarker("provider_stt", "force_finalized");
    expect(m.kind).toBe("endpoint");
    expect(m.text).toMatch(/force-finalized.*timeout/i);
  });

  it("flags a typed turn and never claims an endpointer fired", () => {
    const m = endpointingMarker("text", "typed");
    expect(m.kind).toBe("typed");
    expect(m.text).toMatch(/typed/i);
    // It must not say an endpointer decided the turn ended — only that none ran.
    expect(m.text).not.toMatch(/decided you had finished|force-finalized|marked the end/i);
  });

  it("says the cause is unknown rather than guessing when the owner is absent", () => {
    const m = endpointingMarker(undefined, undefined);
    expect(m.kind).toBe("unknown");
    expect(m.text).toMatch(/unknown/i);
  });
});
