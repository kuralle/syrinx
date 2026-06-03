---
id: TTS-02
title: TTFA / TTFB — time to first audio is the TTS latency metric
domain: TTS
tags: [latency, ttfb, ttfa, metrics]
sources: [together-talk, modal-v2v, vapi-latency]
code_refs: [agents/livekit-agents/livekit/agents/tts/tts.py:234, pipecat/src/pipecat/services/tts_service.py:690]
---

**Claim (one line):** The TTS latency figure of merit is **time-to-first-audio (TTFA / TTFB)** — how long after the transcript before the first streamable audio chunk — measured from request start to the first received frame.

**Detail.** Together: *"Time-to-first-audio (TTFA): how long after transcript to produce first streamable audio chunk"* (together-talk L26). Modal frames the same number as TTFB at the client and uses streaming output to minimize it (modal-v2v L35). LiveKit measures TTFB directly: the metrics monitor stamps `ttfb = time.perf_counter() - start_time` on the **first** synthesized-audio event and reports it in `TTSMetrics` (tts.py:234-247; also the streaming path at tts.py:617-618). Pipecat starts a TTFB metric clock the moment text aggregation begins and stops it on first audio — `start_text_aggregation_metrics()` fires when a `TextFrame` enters `process_frame` (tts_service.py:690), so aggregation wait time is counted into the latency budget.

**Prior-art divergence.** Vapi treats the LLM (time-to-first-meaningful-sentence), not TTS, as the dominant bottleneck — *"ASR and TTS are fairly optimized by providers"* (vapi-latency L13) — so it spends saved ms on **higher-fidelity** TTS rather than cutting TTFA further. Together still demands TTFA in the 100-200ms class to fit the v2v budget.

**Implication for Syrinx.** Instrument TTFA per turn (request→first frame), and count sentence-aggregation wait inside it, as Pipecat does — otherwise the metric lies about perceived latency.

Links: [[TTS-01-streaming-vs-batch]] [[TTS-03-sentence-aggregation]] [[TTS-04-rtf]] [[wiki/tts-map]]
