---
id: LAT-02
title: Per-stage TTFT/TTFB instrumentation (how the clones measure the budget)
domain: LAT
tags: [metrics, ttft, ttfb, observability, instrumentation]
sources: [together-talk, modal-v2v]
code_refs: [agents/livekit-agents/livekit/agents/llm/llm.py:296, agents/livekit-agents/livekit/agents/tts/tts.py:234, pipecat/src/pipecat/processors/metrics/frame_processor_metrics.py:88]
---

**Claim (one line):** To split the v2v budget you must emit per-stage first-token/first-byte timers; LiveKit and Pipecat both clock TTFT (LLM) and TTFB (TTS) as *time from request start to the first streamed chunk*.

**Detail.** LiveKit's LLM base wraps the response stream in a metrics monitor: `start_time = time.perf_counter()` then, on the first chunk with content, `ttft = time.perf_counter() - start_time` (`llm/llm.py:283,296-297`). It emits `LLMMetrics{ttft, duration, tokens_per_second, cancelled, ...}` (`metrics/base.py:20-34`; note the `cancelled` flag — needed because preemptive/scrapped generations are cancelled, [[LAT-09-preemptive-generation]]). TTS mirrors this: `ttfb = time.perf_counter() - start_time` on the first audio frame → `TTSMetrics{ttfb, duration, audio_duration, ...}` (`tts/tts.py:229,234-235`, `metrics/base.py:59-66`). STT emits `duration`/`audio_duration` and `acquire_time`/`connection_reused` for WebSocket pools (`metrics/base.py:37-56`). Pipecat does the same via explicit `start_ttfb_metrics()` / `stop_ttfb_metrics()` calls — `_last_ttfb_time = end_time - self._start_ttfb_time`, emitted as a `TTFBMetricsData` inside a `MetricsFrame` (`frame_processor_metrics.py:88-124`); `report_only_initial_ttfb` ensures only the first chunk per turn counts. The JS port carries `ttftMs`/`ttfbMs` (`agents-js/agents/src/metrics/base.ts:30,73`). Together's motivation: "every 10ms matters → need deep observability" (together-talk).

**Prior-art divergence.** LiveKit measures with `perf_counter` (monotonic, immune to wall-clock skew) and reports `ttft=-1` when generation aborts before any token (`llm/llm.py:312`) so scrapped attempts don't pollute the distribution. Pipecat's TTFB is a manual start/stop pair the service author must place, vs LiveKit's automatic stream-wrapping — Pipecat trades boilerplate for flexibility (any processor can be timed).

**Implication for Syrinx.** Emit TTFT and TTFB as first-class monotonic-clock metrics per turn, tagged with a speech/turn id, and exclude cancelled attempts. This is the substrate for budget-split dashboards and for the hedged-request σ thresholds ([[LAT-06-hedged-requests]]).

Links: [[LAT-01-v2v-figure-of-merit]] [[LAT-05-ttft-target-model-size]] [[LAT-09-preemptive-generation]] [[LAT-12-tail-latency]] [[OBS-04-per-stage-latency-metrics]] [[wiki/lat-map]]
