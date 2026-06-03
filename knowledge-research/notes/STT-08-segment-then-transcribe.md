---
id: STT-08
title: Segment-then-transcribe (VAD-gated batch) vs streaming partials
domain: STT
tags: [vad, segmentation, batch, parakeet, latency, trade-off]
sources: [modal-v2v, diagrams]
code_refs: [pipecat/src/pipecat/services/stt_service.py:765-780, agents/livekit-agents/livekit/agents/stt/stream_adapter.py:110]
---

**Claim (one line):** You can skip streaming partials entirely — buffer each VAD-bounded utterance and transcribe it in one batch call at end-of-speech — and still win on total latency, because "the only thing that matters for total voice-to-voice latency is the final-transcript time."

**Detail.** Modal: "using Pipecat's local VAD + turn detection to segment audio and passing that to Parakeet was FASTER than the open-weights streaming STT implementations they tried. No partial-transcript real-time feel, but the only thing that matters for total voice-to-voice latency is the final transcript time" (modal-v2v:33,55). The diagram confirms STT is a separate Parakeet WebSocket service that receives a *segment*, not a continuous partial stream (diagrams:31-38). Pipecat's `SegmentedSTTService` is exactly this mechanism: it buffers audio in a `bytearray` (`:726`), and on `VADUserStoppedSpeakingFrame` it wraps the buffer in a WAV (`setframerate(self.sample_rate)`) and makes one `run_stt()` call (`stt_service.py:765-780`); every emitted `TranscriptionFrame` is force-`finalized=True` because "Segmented STT services process complete speech segments and return a single TranscriptionFrame per segment" (`stt_service.py:739-751`). It keeps a small ~1s pre-roll buffer (`_audio_buffer_size_1s = sample_rate*2`, `:737`) to recover audio before VAD fired. LiveKit's `StreamAdapter` does the identical trick: forward frames to VAD, and on `END_OF_SPEECH` merge frames and call `recognize()` once → emit one `FINAL_TRANSCRIPT` (`stream_adapter.py:110-139`).

**Prior-art divergence.** Streaming providers (Deepgram, Soniox) give you live partials for early/speculative reasoning ([[STT-02-partial-final-lifecycle]]) at the cost of revisable text; segment-then-transcribe (Modal/Parakeet, Whisper) gives a single clean final but no preemption window. Modal's empirical claim is that for *total* v2v latency the partial stream buys nothing if the batch model's final-transcript time is lower.

**Implication for Syrinx.** Benchmark both per provider on **final-transcript latency**, not partial cadence. If we don't use partials for speculative LLM prefill, a fast VAD-gated batch model may be strictly better.

Links: [[STT-01-streaming-vs-batch]] [[STT-02-partial-final-lifecycle]] [[STT-09-streaming-native-vs-whisper]] [[TURN-01-vad-state-machine-hysteresis]] [[STT-08-segment-then-transcribe]]
