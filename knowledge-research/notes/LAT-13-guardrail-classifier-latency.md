---
id: LAT-13
title: Pre-LLM classifier and post-LLM guardrail add latency to the critical path — Together's routing pattern budgets per-model latency
domain: LAT
tags: [latency, guardrail, classifier, routing, pre-llm, post-llm, tts, budget, together]
sources: [together-talk]
code_refs: []
---

**Claim (one line):** Every additional model in the speech path — a pre-LLM routing classifier, a post-LLM safety guardrail, a diarization tagger — consumes latency budget from the same fixed turn window ([[LAT-03-latency-ladder]]), so each must have an explicit SLA and independently scaleable inference endpoint.

**Detail.** Together AI describes a production voice-agent model topology beyond the three-core STT→LLM→TTS cascade (together-talk Q&A):

1. **Pre-LLM routing classifier:** A small, fast model that inspects the user's transcript and routes to the appropriate handler — e.g., "I want a refund" → refund flow, "track my order" → order-tracking flow, general query → main LLM. This adds a model-inference latency before the LLM even starts. Together does not publish numbers, but the classifier must be faster than the LLM it routes to — otherwise routing costs more than it saves.

2. **Post-LLM safety guardrail (pre-TTS):** A content-safety model that inspects the LLM's output text before it reaches TTS ([[ARCH-11-guardrails-before-tts]]). This sits on the critical path between LLM output and TTS input — every millisecond it takes adds directly to v2v latency.

3. **Thinker–talker big-model call:** A small "talker" LLM handles the live conversation but may issue a tool call to a much larger "thinker" model for complex reasoning (together-talk). The larger model's latency is masked by filler speech ("let me think about it") from the talker — but if the filler runs out before the thinker responds, dead air results.

Together's explicit recommendation: "Each added model pressures latency → clear SLAs + independent scaling." The architectural pattern is: every auxiliary model runs on its own inference endpoint (not sharing an LLM server with the main model), has a P95 latency budget allocation, and is independently auto-scaled. If the safety guardrail's P95 exceeds its budget, it degrades the whole pipeline.

**Prior-art divergence.** LiveKit's voice pipeline (`agent_activity.py`) has no hooks for auxiliary classifiers or guardrails — the STT→LLM→TTS path is the only path. Pipecat's `FrameProcessor` chain could insert a classifier processor, but no OSS example exists. The pre-LLM routing classifier is a Together-specific documented pattern not replicated in any clone; the post-LLM guardrail is a universal recommendation with zero clone implementations ([[ARCH-11-guardrails-before-tts]]).

**Implication for Syrinx.** Budget auxiliary-model latency explicitly in the turn-budget split ([[LAT-04-turn-budget-split]]). If a pre-LLM classifier takes 50 ms P95, shrink the LLM budget by 50 ms. If a safety guardrail adds another 50 ms, shrink it again. Each auxiliary model needs its own [[OBS-04-per-stage-latency-metrics]] histogram and P95 SLO. And critically: the guardrail and the LLM must NOT share an inference server — if the LLM is queueing behind a guardrail request, the cascade doubles.

Links: [[ARCH-11-guardrails-before-tts]] [[LAT-04-turn-budget-split]] [[LAT-03-latency-ladder]] [[OBS-04-per-stage-latency-metrics]] [[LAT-11-filler-speech]]
