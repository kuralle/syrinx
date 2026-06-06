// SPDX-License-Identifier: MIT

import type { TurnBoundaryEventPacket } from "./packets.js";

/** Monotonic clock immune to system-clock adjustments; ms since an arbitrary origin. */
export function monotonicNowMs(): number {
  return performance.timeOrigin + performance.now();
}

/** One step of a reconstructed turn timeline, with elapsed ms since the prior boundary. */
export interface TurnTimelineStep {
  readonly boundary: TurnBoundaryEventPacket["boundary"];
  readonly speechId: string;
  readonly monotonicMs: number;
  /** ms since the previous boundary in this reconstruction (0 for the first). */
  readonly sincePrevMs: number;
  readonly cancelled: boolean;
}

/**
 * Incident reconstruction (VE-07.5): given the `obs.turn_boundary` events for one
 * session id, return the ordered turn timeline with inter-boundary deltas so a
 * developer can replay what happened from a single session id.
 */
export function reconstructTurnTimeline(
  events: readonly TurnBoundaryEventPacket[],
  sessionId: string,
  speechId?: string,
): TurnTimelineStep[] {
  const ordered = events
    .filter((e) => e.sessionId === sessionId && (speechId === undefined || e.speechId === speechId))
    .slice()
    .sort((a, b) => a.monotonicMs - b.monotonicMs);
  let prevMs: number | null = null;
  return ordered.map((e) => {
    const sincePrevMs = prevMs === null ? 0 : Math.max(0, e.monotonicMs - prevMs);
    prevMs = e.monotonicMs;
    return {
      boundary: e.boundary,
      speechId: e.speechId,
      monotonicMs: e.monotonicMs,
      sincePrevMs,
      cancelled: e.cancelled === true,
    };
  });
}

export interface MetricTags {
  readonly [key: string]: string;
}

export interface SpanHandle {
  end(tags?: MetricTags): void;
}

/** Export seam — implementations (Prometheus/OTel) live in optional packages, NOT here. */
export interface MetricsExporter {
  observeHistogram(name: string, valueMs: number, tags: MetricTags): void;
  startSpan(name: string, tags: MetricTags): SpanHandle;
}

/** Default no-op exporter (core never depends on a backend). */
export const noopMetricsExporter: MetricsExporter = {
  observeHistogram() {},
  startSpan() {
    return { end() {} };
  },
};

/** In-memory exporter for tests + incident reconstruction. */
export class InMemoryMetricsExporter implements MetricsExporter {
  readonly histograms: Array<{ name: string; valueMs: number; tags: MetricTags }> = [];
  readonly spans: Array<{ name: string; tags: MetricTags; durationMs?: number }> = [];

  observeHistogram(name: string, valueMs: number, tags: MetricTags): void {
    this.histograms.push({ name, valueMs, tags });
  }

  startSpan(name: string, tags: MetricTags): SpanHandle {
    const startMs = monotonicNowMs();
    const spanIndex = this.spans.length;
    this.spans.push({ name, tags });
    return {
      end: (endTags?: MetricTags) => {
        this.spans[spanIndex] = {
          name,
          tags: endTags ?? tags,
          durationMs: monotonicNowMs() - startMs,
        };
      },
    };
  }
}
