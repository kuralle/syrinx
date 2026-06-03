---
id: TURN-02
title: Dynamic VAD/endpointing baseline via rolling percentile and EMA learning
domain: TURN
tags: [vad, baseline, percentile, ema, adaptation]
sources: [vapi-pipeline-2]
code_refs: [agents-js/agents/src/voice/turn_config/endpointing.ts:90, agents-js/agents/src/voice/turn_config/endpointing.ts:225]
---

**Claim (one line):** A fixed threshold can't serve quiet and loud speakers in noisy rooms, so production systems learn a *moving* baseline — Vapi via an 85th-percentile rolling window, LiveKit-JS via EMA-learned pause delays.

**Detail.** Vapi keeps a **30-second rolling window of audio levels and uses the 85th percentile as a dynamic baseline**, auto-adjusting to quiet/loud speakers (`vapi-pipeline-2` Problem #1). Its audio preprocessor reuses the same trick at finer grain: RMS over **3-second rolling windows of 20ms chunks**, **85th-percentile** dynamic threshold, updated **every 100ms via exponential smoothing**, with a static fallback ~**-35dB** (`vapi-pipeline-2` Problem #2). The clones don't expose a percentile baseline for VAD energy, but LiveKit-JS implements the *endpointing-delay* analog: `DynamicEndpointing` (`endpointing.ts:90`) holds two `ExpFilter`s (`alpha=0.9`) — `#utterancePause` (init=minDelay) and `#turnPause` (init=maxDelay) — and on each end-of-speech *learns* the observed between-utterance vs between-turn pause (`endpointing.ts:225-241`). So `minDelay`/`maxDelay` become per-speaker EMAs clamped to `[minDelay, maxDelay]` rather than constants. Pipecat smooths *volume* with EMA (`vad_analyzer.py:168`, `_smoothing_factor=0.2`) but does not maintain a percentile baseline.

**Prior-art divergence.** Vapi adapts the **VAD energy threshold** (percentile of a level histogram). LiveKit-JS adapts the **endpointing wait** (EMA of pause durations). Both target the same enemy — speaker/environment variance — but at different stages: detection-time gain control vs decision-time patience. Pipecat ships neither adaptive baseline; it expects you to tune static params.

**Implication for Syrinx.** Per-speaker adaptation is a real lever for both false-barge-in and premature-cutoff. Cheapest win: copy LiveKit-JS `DynamicEndpointing` (EMA on pause lengths) since it needs no DSP, only timestamps we already have. A percentile energy baseline (Vapi) is more work but pays off on telephony where one global `min_volume` is wrong.

Links: [[TURN-01-vad-state-machine-hysteresis]] [[TURN-03-semantic-vs-timeout-endpointing]] [[wiki/turn-map]]
