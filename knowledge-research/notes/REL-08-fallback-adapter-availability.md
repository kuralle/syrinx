---
id: REL-08
title: Provider FallbackAdapter — automatic STT/TTS failover with availability tracking
domain: REL
tags: [failover, fallback, provider, availability, recovery, stt, tts]
sources: [vapi-pipeline-2, deepgram-ebook]
code_refs: [agents/livekit-agents/livekit/agents/stt/fallback_adapter.py:41, agents/livekit-agents/livekit/agents/stt/fallback_adapter.py:211, agents/livekit-agents/livekit/agents/stt/fallback_adapter.py:175, agents/livekit-agents/livekit/agents/tts/fallback_adapter.py:46]
---

**Claim (one line):** Wrap N providers behind one adapter that tries them in priority order, marks a failed provider *unavailable* so subsequent requests skip it, and runs a background recovery probe to mark it available again — failover without a per-request retry tax on every turn.

**Detail.** LiveKit's `stt.FallbackAdapter(stt: list[STT], attempt_timeout=10.0, max_retry_per_stt=1, retry_interval=5)` (`stt/fallback_adapter.py:41-93`) keeps a `_STTStatus(available, recovering_recognize_task, recovering_stream_task)` per provider (line 34-39). `_recognize_impl` iterates providers, calling each only `if stt_status.available or all_failed`; on any exception it flips `available=False` and emits `stt_availability_changed` (line 211-243). Crucially it does **not** keep retrying the dead provider on the hot path — instead `_try_recovery` spawns a *background* task that re-probes the failed provider, and only on a successful probe (for streaming: a non-empty `FINAL_TRANSCRIPT`, line 412-423) flips it back to `available=True` (line 175-209). If *all* providers are down, `all_failed` lets it try them anyway, else it raises `APIConnectionError` (line 245-247). The streaming path even forwards the input audio to recovering streams in parallel so recovery is warm (`_forward_input_task`, line 304-328). To avoid double-retrying, the adapter sets `DEFAULT_FALLBACK_API_CONNECT_OPTIONS = max_retry=0` (line 22-25) — the adapter *is* the retry strategy. TTS has the twin `tts.FallbackAdapter` with `max_retry_per_tts=2`, auto-resampling each provider to a common `sample_rate = max(t.sample_rate)` (`tts/fallback_adapter.py:46-100`). Same pattern in LiveKit JS (`agents-js/.../stt/fallback_adapter.ts:91`, `attemptTimeoutMs/maxRetryPerSTT/retryIntervalMs`). Source backing: Vapi runs "multiple STT providers with automatic fallback if primary fails" (vapi-pipeline-2 §3); Deepgram: "define fallback behaviors when upstream services degrade so callers never experience unexplained silence" (ebook 769-770).

**Prior-art divergence.** LiveKit's failover is **stateful** (availability flags + background recovery) so a flapping provider isn't retried on every utterance — distinct from a naive try/except-next-provider that pays the timeout cost each turn. Vapi describes the same behavior at the product level but also layers it with per-deployment hedging at the *LLM* layer ([[LAT-06-hedged-requests]]). Pipecat has no single FallbackAdapter class; it expects app code to catch non-fatal `push_error` and switch services ([[REL-06-graceful-degradation-layered]]).

**Implication for Syrinx.** Front STT and TTS with a stateful fallback wrapper: priority list, per-provider availability flag, background recovery probe, and `max_retry=0` inside the wrapper (the wrapper owns retry). Emit availability-change events for [[OBS-01-event-instrumentation-turn-boundaries]].

Links: [[REL-06-graceful-degradation-layered]] [[REL-01-reconnect-exponential-backoff]] [[LAT-06-hedged-requests]] [[STT-01-streaming-vs-batch]] [[REL-10-failure-mode-catalog]]
