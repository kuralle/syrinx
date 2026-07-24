---
title: Observability & analytics
description: Build a metrics dashboard from the engine's structured signals.
---

Syrinx emits structured, low-cardinality signals as a call runs — usage, latency, acoustic events, and per-turn health. Point them at your metrics backend and you have a live dashboard without instrumenting any provider yourself. Billing, dashboards, and evals are all downstream consumers of the same signals.

## Two ways to consume signals

- **A metrics exporter** — implement `MetricsExporter` and pass it to the session; the engine calls it with counters, histograms, and spans as work happens. This is the path for Prometheus / OpenTelemetry / Datadog.
- **Bus packets** — subscribe directly to `usage.recorded`, `metric.conversation`, `acoustic.signal`, and `turn.localization` on `session.bus` for custom handling.

## Metrics exporter

`MetricsExporter` is the export seam. Implement it to forward every metric to your backend — Prometheus, OpenTelemetry, or Datadog. This one prints Prometheus-style lines; swap the bodies for a real client:

```ts
import { VoiceAgentSession, type MetricsExporter, type MetricTags } from '@kuralle-syrinx/core';

const fmt = (tags: MetricTags) =>
  Object.entries(tags).filter(([, v]) => v != null).map(([k, v]) => `${k}="${v}"`).join(',');

const dashboardExporter: MetricsExporter = {
  observeCounter(name, value, tags) { console.log(`counter ${name} ${value} {${fmt(tags)}}`); },
  observeHistogram(name, valueMs, tags) { console.log(`histogram ${name} ${valueMs}ms {${fmt(tags)}}`); },
  startSpan(name, tags) {
    const startMs = Date.now();
    return { end: () => console.log(`span ${name} ${Date.now() - startMs}ms {${fmt(tags)}}`) };
  },
};

const session = new VoiceAgentSession({ plugins, metricsExporter: dashboardExporter });
```

A live call then streams metrics like:

```
counter usage.audioSeconds 8.98 {provider="deepgram",model="nova-3",stage="stt",layer="infrastructure"}
counter usage.outputTokens 121 {provider="openai",model="gpt-4.1-mini",stage="llm",layer="infrastructure"}
counter usage.characters 38 {provider="cartesia",model="sonic-3",stage="tts",layer="infrastructure"}
counter acoustic.interruption 1 {layer="conversation"}
```

:::tip
This exporter is a runnable file — [`observability-dashboard.ts`](https://github.com/kuralle/syrinx/blob/main/examples/02-hello-voice-headless/src/observability-dashboard.ts) on GitHub.
:::

For local development or incident reconstruction, `InMemoryMetricsExporter` captures everything in arrays:

```ts
import { InMemoryMetricsExporter } from '@kuralle-syrinx/core';

const exporter = new InMemoryMetricsExporter();
// after a call: exporter.counters, exporter.histograms, exporter.spans
```

What the engine emits:

| Instrument | Examples | Use for |
|---|---|---|
| **Counter** | `usage.audioSeconds`, `usage.outputTokens`, `usage.characters`, `acoustic.interruption`, `error.stage` | Sums — a bill, a volume, an error count |
| **Histogram** | per-stage latencies | Percentiles — p50/p95 voice-to-voice |
| **Span** | stage timings | Traces |

## Tags: keep cardinality low

Every metric carries `MetricTags` — always **low-cardinality**: `provider`, `model`, `stage`, and a `layer`. **Never** tag by session id or turn id (that explodes cardinality and cost). The engine follows this itself.

The `layer` tag is either `"infrastructure"` or `"conversation"` — so a dashboard can separate "the pipeline broke" from "the agent behaved poorly" instead of collapsing both into one number.

## Was it a system failure or an agent failure?

`localizeTurn()` composes a per-turn verdict from the signals it saw — `"infrastructure"` (an infra breach), `"conversation"` (the agent was flagged), or `"none"`. The session emits it as a `turn.localization` packet, so your dashboard can route incidents to the right owner.

```ts
import { localizeTurn } from '@kuralle-syrinx/core';
```

## Acoustic signals

`acoustic.signal` packets surface what the turn-taking layer already computes — `prosody`, `backchannel`, `interruption`, `primary_speaker`, `echo_rejected`, `cadence`. They're a **signal** surface: feed them into your own sentiment or quality analysis; Syrinx doesn't classify emotion for you.

## Cost

For turning usage into dollars and capping spend, see [Usage & pricing](/reference/usage-and-pricing/).
