// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from "vitest";

import {
  InMemoryMetricsExporter,
  monotonicNowMs,
  noopMetricsExporter,
  reconstructTurnTimeline,
} from "./observability.js";
import type { TurnBoundaryEventPacket } from "./packets.js";

describe("monotonicNowMs", () => {
  it("returns increasing positive numbers", () => {
    const first = monotonicNowMs();
    const second = monotonicNowMs();
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThanOrEqual(first);
  });
});

describe("InMemoryMetricsExporter", () => {
  it("records histogram name, value, and tags", () => {
    const exporter = new InMemoryMetricsExporter();
    exporter.observeHistogram("turn.latency_ms", 42, { sessionId: "s1", boundary: "agent_audio_done" });
    expect(exporter.histograms).toEqual([
      {
        name: "turn.latency_ms",
        valueMs: 42,
        tags: { sessionId: "s1", boundary: "agent_audio_done" },
      },
    ]);
  });

  it("records non-negative span duration on end", () => {
    vi.useFakeTimers();
    const exporter = new InMemoryMetricsExporter();
    const handle = exporter.startSpan("turn.process", { sessionId: "s1" });
    vi.advanceTimersByTime(10);
    handle.end();
    expect(exporter.spans).toHaveLength(1);
    expect(exporter.spans[0]?.durationMs).toBeGreaterThanOrEqual(0);
    vi.useRealTimers();
  });
});

describe("noopMetricsExporter", () => {
  it("accepts histogram and span calls without throwing", () => {
    noopMetricsExporter.observeHistogram("ignored", 0, {});
    noopMetricsExporter.startSpan("ignored", {}).end();
  });
});

describe("reconstructTurnTimeline", () => {
  function ev(sessionId: string, speechId: string, boundary: TurnBoundaryEventPacket["boundary"], monotonicMs: number, cancelled = false): TurnBoundaryEventPacket {
    return { kind: "obs.turn_boundary", contextId: speechId, timestampMs: 0, boundary, sessionId, speechId, monotonicMs, cancelled };
  }

  it("orders one session's boundaries by monotonic time with inter-boundary deltas", () => {
    const events = [
      ev("sess-A", "turn-1", "agent_started_speaking", 300),
      ev("sess-A", "turn-1", "user_started_speaking", 100),
      ev("sess-B", "turn-9", "user_started_speaking", 150), // other session — excluded
      ev("sess-A", "turn-1", "user_stopped_speaking", 200),
    ];
    const timeline = reconstructTurnTimeline(events, "sess-A");
    expect(timeline.map((s) => s.boundary)).toEqual([
      "user_started_speaking",
      "user_stopped_speaking",
      "agent_started_speaking",
    ]);
    expect(timeline.map((s) => s.sincePrevMs)).toEqual([0, 100, 100]);
    expect(timeline.every((s) => s.speechId === "turn-1")).toBe(true);
  });

  it("filters by speechId when provided and surfaces the cancelled flag", () => {
    const events = [
      ev("s", "t1", "user_started_speaking", 10),
      ev("s", "t2", "interruption", 20, true),
    ];
    const t2 = reconstructTurnTimeline(events, "s", "t2");
    expect(t2).toHaveLength(1);
    expect(t2[0]!.cancelled).toBe(true);
  });
});
