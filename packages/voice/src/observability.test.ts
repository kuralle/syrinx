// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from "vitest";

import {
  InMemoryMetricsExporter,
  monotonicNowMs,
  noopMetricsExporter,
} from "./observability.js";

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
