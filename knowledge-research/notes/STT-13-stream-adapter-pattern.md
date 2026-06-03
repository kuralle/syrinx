---
id: STT-13
title: The StreamAdapter pattern — wrapping a batch STT as a pseudo-streaming socket via VAD segmentation
domain: STT
tags: [stream-adapter, batch-stt, vad, streaming, adapter-pattern, livekit, pipecat]
sources: []
code_refs: [agents/livekit-agents/livekit/agents/stt/stream_adapter.py:18, pipecat/src/pipecat/services/stt_service.py:704]
---

**Claim (one line):** A StreamAdapter wraps a batch-STT model (e.g., Whisper) behind a VAD-based segmenter, emitting only final transcripts (no interim/partial events) on the same streaming interface as a native streaming model — enabling provider-agnostic STT at the cost of segment-delay latency.

**Detail.** LiveKit's `StreamAdapter` (`stt/stream_adapter.py:18`) is the canonical implementation: it consumes a raw audio `AudioFrame` stream, runs VAD to detect speech segments, and feeds each complete (merged-frame) segment to a batch `STT` recognizer. The recognizer returns a final transcript, which the adapter wraps and emits as a `SpeechEvent(type=FINAL_TRANSCRIPT)` — its capabilities declare `interim_results=False`, so no partial/interim transcripts are produced. The adapter also emits a `START_OF_SPEECH` event on VAD trigger and an `END_OF_SPEECH` on VAD silence, so the upstream pipeline sees the same event interface as a native streaming STT socket. The VAD is a required constructor argument (`__init__(self, *, stt, vad)`) — there is no default VAD; the caller must pass one explicitly.

Pipecat's equivalent is `SegmentedSTTService` (`stt_service.py:704-807`): it accumulates audio into a `bytearray`, runs VAD to find utterance boundaries, writes a WAV file for each segment, and submits it to a batch STT provider. Unlike LiveKit's real-time adapter, Pipecat's segmented service is a `FrameProcessor` in the pipeline chain — it processes frames as they arrive rather than wrapping a provider, but achieves the same outcome: batch models appear streaming.

**Prior-art divergence.** LiveKit's `StreamAdapter` is a transparent decorator — any batch STT can be wrapped. Pipecat's `SegmentedSTTService` is a standalone processor requiring explicit pipeline insertion. Modal's approach (batch STT via VAD-gated WAV) is the extreme case: skip streaming entirely and bet that a fast batch model on a pre-segmented recording beats a streaming model on the same audio ([[STT-08-segment-then-transcribe]]). The trade is the same across all: you get the accuracy of a batch model (typically higher WER on technical terms) but pay the **segment delay** — the VAD must confirm silence before the segment is cut, adding `stop_secs` (0.2 s in current Pipecat `VADParams`; the historical 0.8 s default was lowered) to the end of every utterance.

**Implication for Syrinx.** The StreamAdapter pattern is essential for provider fallback: if the primary streaming STT fails over, a StreamAdapter-wrapped batch model gives a degraded-but-functional backup without changing the orchestration interface. Keep the VAD silence timer short on the adapter path to minimize segment delay; accept the accuracy trade-off as the price of availability.

Links: [[STT-01-streaming-vs-batch]] [[STT-08-segment-then-transcribe]] [[STT-09-streaming-native-vs-whisper]] [[TURN-01-vad-state-machine-hysteresis]] [[ARCH-08-livekit-agentsession]]
