---
id: OBS-04
title: Per-stage latency metrics — LiveKit metrics dataclasses + Pipecat TTFB frames
domain: OBS
tags: [observability, latency, ttft, ttfb, stt, llm, tts, metrics]
sources: [deepgram-ebook, together-talk, modal-v2v]
code_refs: [agents/livekit-agents/livekit/agents/metrics/base.py:20, pipecat/src/pipecat/metrics/metrics.py:29, pipecat/src/pipecat/services/tts_service.py:1082, pipecat/src/pipecat/services/stt_service.py:565]
---

**Claim (one line):** Below the end-to-end number, each stage emits one canonical latency field — STT `audio_duration`/TTFB, LLM **ttft**, TTS **ttfb** — and the clones report these as strongly-typed per-request records so the e2e latency can be decomposed and the slow stage localized.

**Detail.** Deepgram requires "Metric derivation that computes per-stage latency for speech recognition, reasoning, and synthesis, as well as end-to-end turn timing" (deepgram-ebook line 1027–1028). Together: TTFT target ≈200–300ms, TTFA = transcript→first streamable audio, and "every 10ms matters" → deep observability (together-talk line 22,26,33). LiveKit's `metrics/base.py` is the gold reference — each is a Pydantic model with `request_id`, `timestamp`, `duration`:
- `LLMMetrics` (line 20): **`ttft`**, `tokens_per_second`, `prompt_cached_tokens`, `completion_tokens`.
- `TTSMetrics` (line 59): **`ttfb`**, `audio_duration`, `characters_count`, `acquire_time`/`connection_reused` (WebSocket pool timing).
- `STTMetrics` (line 37): `audio_duration`, `streamed`, `acquire_time`.
- `RealtimeModelMetrics` (line 115): `ttft` = "time to first audio token, −1 if no audio token" — the S2S analogue.

Pipecat models the same as `TTFBMetricsData`/`ProcessingMetricsData` (`metrics/metrics.py:29,39`), measured by a `start_ttfb_metrics`/`stop_ttfb_metrics` bracket on the `FrameProcessor` (`frame_processor.py:425,437`) that pushes a `MetricsFrame` downstream. The mechanism is precise: TTS starts the clock when synthesis begins (`tts_service.py:1082`) and stops on the **first audio chunk** (`tts_service.py:1488`); STT starts at `speech_end_time = frame.timestamp − stop_secs` and stops at `_last_transcript_time` (`stt_service.py:565,584`) — i.e. STT "TTFB" *is* transcription delay.

**Prior-art divergence.** LiveKit emits one typed event **per provider request** (request_id-keyed, billing-grade) and rolls them into per-turn OTel histograms `lk.agents.turn.llm_ttft` / `tts_ttfb` (`otel_metrics.py:28,33`). Pipecat emits a generic `TTFBMetricsData{processor,value}` **per frame-processor** and reconstructs the timeline in an observer. LiveKit's split of `acquire_time` (connection acquisition) from `ttfb` (inference) is a sharper decomposition than Pipecat's single TTFB.

**Implication for Syrinx.** Emit a typed per-stage record keyed by request_id: STT(audio_duration, transcription_delay), LLM(ttft, tps), TTS(ttfb, audio_duration), plus `acquire_time` for any pooled WebSocket. e2e = Σ(stages)+endpointing; the gap between measured e2e and the sum is your orchestration overhead.

Links: [[OBS-02-canonical-timing-metric]] [[OBS-05-eou-vs-transcription-delay]] [[OBS-08-otel-traces-spans]] [[LAT-02-per-stage-metrics]] [[STT-02-partial-final-lifecycle]] [[TTS-02-ttfa-ttfb]]
