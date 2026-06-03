---
id: STT-07
title: STT provider fallback / failover and reconnection
domain: STT
tags: [fallback, failover, reconnect, keepalive, reliability]
sources: [vapi-pipeline-2, deepgram-ebook]
code_refs: [agents/livekit-agents/livekit/agents/stt/fallback_adapter.py:211, pipecat/src/pipecat/services/deepgram/stt.py:622]
---

**Claim (one line):** Production STT runs behind a fallback adapter that fails over to a secondary provider on error and probes the failed one for recovery in the background, plus per-socket reconnect + keepalive so a transient drop doesn't lose the turn.

**Detail.** Vapi: "Multiple STT providers with automatic fallback if primary fails; handle provider-specific quirks while keeping consistent behavior" (vapi-pipeline-2:33). LiveKit's `FallbackAdapter` implements this concretely: it holds an ordered `_stt_instances` list with per-instance `available` status; `_recognize_impl` tries each available STT in order, and on exception marks it unavailable, emits `stt_availability_changed`, and moves to the next (`fallback_adapter.py:211-243`). A failed provider isn't abandoned — `_try_recovery` spawns a background task that re-probes it and flips `available=True` on success (`fallback_adapter.py:175-209`). If *all* fail it still retries them all (`:220-226`). At the single-socket level, reliability is reconnect + keepalive: Pipecat's `_connection_handler` wraps the socket in a `while True` retry loop that reconnects "automatically after transient errors" (`deepgram/stt.py:622-650`), and `_keepalive_handler` sends a KeepAlive every 5s because "Deepgram closes inactive connections after 10 seconds (NET-0001)" (`deepgram/stt.py:652-665`). On reconnect Pipecat replays buffered audio only after `_connection_ready` is set (`deepgram/stt.py:463-479`; buffer at `stt_service.py:361-363`). Deepgram's own guidance: "Streaming connections should implement reconnection logic with exponential [backoff]" (deepgram-ebook:592).

**Prior-art divergence.** LiveKit gives a first-class **cross-provider** `FallbackAdapter` with background recovery + availability events; Pipecat focuses on **single-provider** auto-reconnect/keepalive and leaves cross-provider switching to a `ServiceSwitcher` higher up. Rapida enables keepalive at the SDK client (`EnableKeepAlive: true`, `voice-ai/.../transformer/deepgram/stt.go:80`) and reconnects by re-initializing.

**Implication for Syrinx.** We want both layers: per-socket reconnect+keepalive *and* an ordered multi-provider fallback with background recovery probes and availability events for observability.

Links: [[STT-06-wer-unrecoverable]] [[STT-01-streaming-vs-batch]] [[REL-01-reconnect-exponential-backoff]] [[REL-03-keepalive-idle-socket]]
