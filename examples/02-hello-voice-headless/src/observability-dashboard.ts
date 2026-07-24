// SPDX-License-Identifier: MIT
//
// The runnable version of the "Observability & analytics" docs page. A MetricsExporter
// forwards the engine's counters, histograms, and spans to your metrics backend — here
// it prints Prometheus-style lines; swap the bodies for a real Prometheus / OpenTelemetry /
// Datadog client. Pass it to VoiceAgentSession as `metricsExporter`.
//
// See docs: /reference/observability

import { VoiceAgentSession, type MetricsExporter, type MetricTags } from "@kuralle-syrinx/core";

function fmt(tags: MetricTags): string {
  return Object.entries(tags)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${k}="${v}"`)
    .join(",");
}

/** Forwards every engine metric to your backend. Replace the console.log bodies with a client. */
export const dashboardExporter: MetricsExporter = {
  // Sums — usage.audioSeconds, usage.outputTokens, usage.characters, acoustic.*, error.stage.
  observeCounter(name, value, tags) {
    console.log(`counter ${name} ${value} {${fmt(tags)}}`);
  },
  // Distributions — per-stage latency for p50/p95 voice-to-voice.
  observeHistogram(name, valueMs, tags) {
    console.log(`histogram ${name} ${valueMs}ms {${fmt(tags)}}`);
  },
  // Traces — stage spans.
  startSpan(name, tags) {
    const startMs = Date.now();
    return { end: () => console.log(`span ${name} ${Date.now() - startMs}ms {${fmt(tags)}}`) };
  },
};

/** Wire the exporter into a session — every stage now reports to your dashboard. */
export function createSessionWithDashboard(
  plugins: ConstructorParameters<typeof VoiceAgentSession>[0]["plugins"],
): VoiceAgentSession {
  return new VoiceAgentSession({ plugins, metricsExporter: dashboardExporter });
}
