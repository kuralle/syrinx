---
id: REL-13
title: Streaming STT fallback does NOT replay buffered mid-turn audio — LiveKit's FallbackAdapter recognize-vs-stream semantics
domain: REL
tags: [fallback, failover, stt, streaming, mid-turn, audio-buffer, replay, semantics]
sources: [deepgram-ebook, vapi-pipeline-2]
code_refs: [agents/livekit-agents/livekit/agents/stt/fallback_adapter.py:119, agents/livekit-agents/livekit/agents/stt/fallback_adapter.py:280, agents/livekit-agents/livekit/agents/stt/fallback_adapter.py:304]
---

**Claim (one line):** LiveKit's `FallbackAdapter` has two separate paths with different mid-turn semantics — `recognize()` replays the full audio buffer to each fallback provider (turn audio preserved), but `stream()` forwards live audio only from the failover point forward (mid-turn audio is lost) — so a streaming provider failover mid-utterance silently drops the words already spoken.

**Detail.** LiveKit's `FallbackAdapter` (`stt/fallback_adapter.py`) wraps multiple STT providers for automatic failover. It exposes two recognition methods with fundamentally different replay behavior:

**`recognize()` path** (batch, lines 119-256): The caller provides a complete `buffer: utils.AudioBuffer`. On failure, `_try_recognize()` passes the **same buffer** to each subsequent STT provider (`stt.recognize(buffer, ...)` at line 127). The recovery probe (`_try_recovery` at line 243) also receives the same buffer. This path **preserves mid-turn audio**: if STT-1 fails, STT-2 gets the full utterance and can produce a correct transcript. The cost is that `recognize()` blocks until the utterance is complete — it's the batch path, not the streaming path.

**`stream()` path** (streaming, lines 280-375): The `FallbackRecognizeStream` creates a live stream for the first available STT. It starts a `_forward_input_task` (line 304) that forwards incoming `rtc.AudioFrame` chunks to the main stream and any recovering streams. When the main stream fails (timeout, API error, or crash), the loop `continue`s to the next provider and creates a **new** `main_stream`. But `_forward_input_task` only forwards data from `self._input_ch` — which is the *live* audio channel. **Audio chunks already forwarded to the failed stream are not replayed** to the new stream. The new provider starts from silence at the failover point, losing any words spoken between utterance-start and the failover moment. The client hears the agent fail to respond (dead air) or respond to a truncated transcript.

**Recovery semantics.** The streaming recovery path (`_try_recovery` at lines 392-448) is async and non-blocking: recovering streams are added to `self._recovering_streams` and receive forwarded audio in parallel, but they're only used for the recovery probe (the first `FINAL_TRANSCRIPT`, lines 412-417, triggers availability). They don't catch up the failed turn.

**Prior-art divergence.** Vapi describes "multiple STT providers with automatic fallback if primary fails" (vapi-pipeline-2 §3) but does not specify whether mid-turn audio is preserved. Pipecat has no `FallbackAdapter` class — its STT failover must be implemented at the application level. The `recognize()` path's full-buffer replay is the more reliable option for production if batch latency is acceptable; the `stream()` path's silent mid-turn loss is a hard correctness gap that should be explicitly documented and measured.

**Implication for Syrinx.** If streaming STT is the primary path, implement a replay buffer: on STT stream failure, flush the accumulated mid-turn audio (since VAD-start) to the fallback provider before resuming live forwarding. This turns the worst failure — "agent heard nothing I said" — into a delayed-but-correct response. Measure the replay latency cost; it's one extra STT inference of the lost prefix.

Links: [[STT-07-provider-fallback]] [[STT-01-streaming-vs-batch]] [[REL-08-fallback-adapter-availability]] [[REL-06-graceful-degradation-layered]] [[XPORT-05-frame-chunk-sizing]]
