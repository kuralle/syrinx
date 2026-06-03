---
id: LAT-09
title: Speculative / preemptive generation on a predicted endpoint
domain: LAT
tags: [latency, speculative, preemptive, llm, eou, masking]
sources: [el-orchestration, vapi-pipeline-1]
code_refs: [agents/livekit-agents/livekit/agents/voice/agent_activity.py:1872, agents/livekit-agents/livekit/agents/voice/turn.py:128]
---

**Claim (one line):** Fire the LLM (and optionally TTS) speculatively *before* the user's turn is confirmed, on a predicted end-of-utterance, so the first token is already in flight when the turn-end verdict arrives — removing LLM TTFT from the perceived critical path.

**Detail.** ElevenLabs' golden nugget: the orchestrator "reduces *perceived* LLM latency by **predicting when a user has finished speaking. In some cases this results in multiple LLM generation requests with the same conversation context within a single turn**" (el-orchestration) — i.e. speculative generation on a predicted endpoint, with <100ms orchestration overhead. LiveKit implements this as **preemptive generation** (`turn.py:128-155`): on a predicted EOU, `on_preemptive_generation()` calls `_generate_reply(..., schedule_speech=False)` to start the LLM but *not* speak yet (`agent_activity.py:1896-1919`). Config (`turn.py:128-155`): `enabled=True` by default; `preemptive_tts=False` (LLM runs preemptively but TTS waits for turn confirmation — flip to also speculate TTS, `agent_activity.py:2572-2580`); `max_speech_duration=10.0s` (skip preemption for long utterances "more likely to change"); `max_retries=3` attempts per turn, counter reset at turn end (`agent_activity.py:1985,1894`). When the turn truly completes, the speculative result is *kept* only if context still matches (the validation/scrap step is [[LAT-10-predict-and-scrap]]); `agent_activity.py:2101-2104` logs the saved `preemptive_lead_time`. The JS port is identical: `_preemptiveGeneration`, `maxSpeechDuration` (10000ms), `maxRetries` (`agents-js/agents/src/voice/agent_activity.ts:1391-1438`).

**Prior-art divergence.** ElevenLabs/Vapi describe the *behavior* (multiple same-context requests per turn); LiveKit exposes it as tunable knobs with explicit guards (`max_retries`, `max_speech_duration`) to bound the wasted-token cost — speculation trades tokens for latency, so it is capped. `preemptive_tts` default-off shows TTS speculation is treated as more expensive/risky than LLM speculation.

**Implication for Syrinx.** Implement preemptive LLM generation gated on a fast EOU predictor, with a retry cap and a max-speech-duration cutoff so wasted spend is bounded. Keep TTS speculation behind a flag. Requires the cancel/validate machinery of [[LAT-10-predict-and-scrap]].

Links: [[LAT-10-predict-and-scrap]] [[LAT-04-turn-budget-split]] [[LAT-05-ttft-target-model-size]] [[TURN-06-livekit-eou-internals]] [[wiki/lat-map]]
