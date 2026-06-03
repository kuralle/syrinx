---
id: OBS-06
title: SLOs for the speech path — percentile/tail latency, not averages
domain: OBS
tags: [observability, slo, percentile, tail-latency, p95, monitoring]
sources: [deepgram-ebook, vapi-latency, modal-v2v]
code_refs: [agents/livekit-agents/livekit/agents/telemetry/otel_metrics.py:23, agents/livekit-agents/livekit/agents/metrics/usage_collector.py]
---

**Claim (one line):** Voice-path SLOs must be expressed on **tail percentiles** (P95/P99) of the per-turn latency distribution, because worst-case turns — not the mean — are what break a conversation, and the telemetry must therefore be a histogram, not a running average.

**Detail.** Deepgram's SLO trio: "Response latency remaining below a defined percentile threshold," "Interruption handling success staying within tolerance bands," "Error rates remaining below predefined limits" (deepgram-ebook line 1046–1049); dashboards show "latency percentiles, interruption success rates, and error counts" (line 1042). The tail discipline is explicit in load testing: "track **tail latency rather than averages, since worst-case delays dominate user perception**" (line 996–997). Vapi concurs from production — their hedging system "shaved >1000ms off **P95**," and "Tail latency (P95/P99), not average, is what breaks conversation" (vapi-latency line 38,43); they track latency per-region/per-deployment because provider latency is volatile (line 42). Modal selects its LLM inference engine by **P95 TTFT** and visualizes deployments as v2v-latency **eCDFs** (modal-v2v line 47,57). The clones encode the histogram shape directly: LiveKit registers every per-turn metric as an OTel **histogram** (`lk.agents.turn.e2e_latency`, `…llm_ttft`, `…tts_ttfb`, `…transcription_delay`, `otel_metrics.py:23–47`) so any percentile is queryable downstream (Prometheus/Grafana), and exposes a Prometheus `/metrics` HTTP endpoint (`telemetry/http_server.py`).

**Prior-art divergence.** LiveKit emits histograms (percentile-ready by construction) and a `UsageCollector`/`ModelUsageCollector` for session aggregation. Pipecat emits per-cycle `LatencyBreakdown` events and leaves percentile aggregation to the consumer's sink. Deepgram pushes raw event telemetry to Datadog/Grafana/CloudWatch and defines SLOs at that layer (line 1029,1042). All three agree the *raw* signal is per-turn and the *SLO* is a percentile over a window — never instrument the average.

**Implication for Syrinx.** Record per-turn latency as a histogram and set SLOs as P95/P99 bounds per (region, provider-deployment). Alert on **sustained percentile deviation** (Deepgram: "rising tail latency," line 1031), not single slow turns. Mean latency is a vanity metric here.

Links: [[OBS-02-canonical-timing-metric]] [[OBS-03-vaqi-i-m-l]] [[OBS-09-replay-load-fault-injection]] [[OBS-10-synthetic-real-user-monitoring]] [[LAT-06-hedged-requests]] [[REL-06-graceful-degradation-layered]]
