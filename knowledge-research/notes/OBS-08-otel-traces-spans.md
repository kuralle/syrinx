---
id: OBS-08
title: OpenTelemetry traces — per-turn spans with TTFT/TTFB/EOU attributes
domain: OBS
tags: [observability, opentelemetry, tracing, spans, ttft, ttfb]
sources: [deepgram-ebook, together-talk]
code_refs: [agents/livekit-agents/livekit/agents/telemetry/trace_types.py:60, agents/livekit-agents/livekit/agents/voice/agent_activity.py:2771, pipecat/src/pipecat/utils/tracing/service_attributes.py:93, pipecat/src/pipecat/utils/tracing/turn_trace_observer.py:36]
---

**Claim (one line):** Both clones export the speech path as OpenTelemetry traces — a span tree of conversation → turn → {STT, LLM, TTS} spans, each annotated with the stage's latency attributes — so a single laggy turn is a visibly long child span, not a number to correlate by hand.

**Detail.** LiveKit attaches typed span attributes on the user-turn / agent-turn spans: `lk.e2e_latency`, `lk.transcription_delay`, `lk.end_of_turn_delay`, `lk.user_transcript`, `lk.transcript_confidence`, `lk.eou.probability`, `lk.eou.endpointing_delay`, `lk.provider.request_ids` (`trace_types.py:54–69`), e.g. `current_span.set_attribute(trace_types.ATTR_E2E_LATENCY, e2e_latency)` (`agent_activity.py:2771`). Pipecat builds the hierarchy with a `TurnTraceObserver` where "Service spans (STT, LLM, TTS) become children of the turn spans" and turns are children of a conversation span (`turn_trace_observer.py:36–45`); service spans follow GenAI semantic conventions — `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.operation.name`, `gen_ai.output.type=speech` for TTS (`service_attributes.py:93–96`). Deepgram's observability layer assumes exactly this — emit timestamped events feeding "Storage and visualization using systems such as Datadog, Grafana, or CloudWatch" (deepgram-ebook line 1029–1030). Together's "every 10ms matters" and per-component SLAs (together-talk line 33,42) presume span-level visibility into each model hop.

**Prior-art divergence.** LiveKit also exposes a **Prometheus** `/metrics` endpoint (`telemetry/http_server.py`) and per-turn OTel **histograms** (`otel_metrics.py`) *alongside* traces — metrics for SLOs, traces for drill-down. Pipecat is traces-first (`utils/tracing/`) and reconstructs latency numbers from observers rather than a parallel metrics export. Pipecat adopts the GenAI OTel semantic conventions; LiveKit uses a custom `lk.*` attribute namespace. For Syrinx, the GenAI conventions are the more portable choice if vendor dashboards expect them.

**Implication for Syrinx.** Export OTel spans (conversation→turn→stage) with e2e_latency, transcription_delay, endpointing_delay, ttft, ttfb as span attributes, *and* a parallel Prometheus histogram export for the percentile SLOs. Traces answer "why was turn 7 slow"; histograms answer "is P95 within SLO." Need both.

Links: [[OBS-04-per-stage-latency-metrics]] [[OBS-06-slos-percentiles-tail]] [[OBS-07-session-id-correlation]] [[OBS-01-event-instrumentation-turn-boundaries]]
