---
id: TURN-08
title: Turn-taking thresholds and the speed–accuracy trade-off
domain: TURN
tags: [thresholds, latency, eot, tuning, stt-safety-net]
sources: [vapi-pipeline-2, deepgram-ebook]
code_refs: [pipecat/src/pipecat/audio/vad/vad_analyzer.py:24, pipecat/src/pipecat/turns/user_stop/speech_timeout_user_turn_stop_strategy.py:48, pipecat/src/pipecat/turns/user_stop/turn_analyzer_user_turn_stop_strategy.py:200, agents/livekit-agents/livekit/agents/voice/agent_session.py:338]
---

**Claim (one line):** Every endpointing threshold is a direct latency-vs-truncation dial — shorter waits cut the user off, longer waits add dead air — so the catalog of defaults is the catalog of trade-offs.

**Detail.** Canonical defaults across the prior art:
- **VAD start** ~200ms, **VAD stop** ~800ms (Vapi, `vapi-pipeline-2`); Pipecat `VAD_START_SECS=0.2`, `VAD_STOP_SECS=0.2`, `confidence=0.7`, `min_volume=0.6` (`vad_analyzer.py:24-27`).
- **Endpointing delay**: LiveKit `min_endpointing_delay=0.5s`, `max_endpointing_delay=3.0s` (`agent_session.py:338-342`); LiveKit-JS `minDelay=500ms`, `maxDelay=3000ms`, `alpha=0.9` ([[TURN-02-dynamic-baseline-percentile]]).
- **Post-pause user window**: Pipecat `SpeechTimeoutUserTurnStopStrategy.user_speech_timeout=0.6s` (`speech_timeout_user_turn_stop_strategy.py:48`).
- **ML turn model**: SmartTurn sigmoid cut `0.5`, silence net `stop_secs=3s`, `pre_speech_ms=500`, `max_duration=8s` [[TURN-05-smartturn-internals]]; LiveKit EOU per-language `unlikely_threshold` from `languages.json`.
- **Flux**: `eot_threshold`, `eager_eot_threshold`, `eot_timeout_ms` "tune the speed–stability trade-off" (`deepgram-ebook` ~548).

Two cross-stage couplings matter. (1) Pipecat runs an **STT-latency safety net**: after VAD stop it waits `max(0, stt_p99_latency − stop_secs)` for the final transcript, and **warns if `stop_secs ≠ 0.2` because the built-in p99 values assume that**, or if `stop_secs ≥ stt_p99` (the STT wait collapses to 0) (`turn_analyzer_user_turn_stop_strategy.py:200-221`). So lengthening VAD `stop_secs` for stability silently eats the STT safety margin. (2) A text-only turn model can't score until STT finalizes [[TURN-06-livekit-eou-internals]], so its accuracy gain costs the STT-final latency on every turn.

**Prior-art divergence.** Vapi advertises the *outcome* of good tuning (−73% premature interruptions, `vapi-pipeline-2`) without exposing the numbers; the clones expose the numbers but leave the policy to you. Pipecat is unique in coupling the turn timer to a measured STT p99; LiveKit couples it to an EMA of observed pauses.

**Implication for Syrinx.** Treat these as one budget, not independent knobs: `VAD stop_secs + endpointing_delay + STT_final_latency` ≈ the perceived "did it cut me off / is it dead air" latency. Benchmark STT p99 for our provider and feed it in (Pipecat's `ttfs_p99_latency`); don't hand-tune `stop_secs` without re-deriving the safety net.

Links: [[TURN-01-vad-state-machine-hysteresis]] [[TURN-02-dynamic-baseline-percentile]] [[TURN-05-smartturn-internals]] [[TURN-06-livekit-eou-internals]] [[wiki/lat-map]] [[wiki/turn-map]]
