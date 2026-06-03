// SPDX-License-Identifier: MIT

/** Monotonic clock immune to system-clock adjustments; ms since an arbitrary origin. */
export function monotonicNowMs(): number {
  return performance.timeOrigin + performance.now();
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
