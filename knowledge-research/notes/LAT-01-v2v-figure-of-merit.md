---
id: LAT-01
title: Voice-to-voice latency is the figure of merit
domain: LAT
tags: [latency, v2v, metric, turn-taking]
sources: [vapi-latency, modal-v2v, together-talk]
code_refs: [agents/livekit-agents/livekit/agents/metrics/base.py:94]
---

**Claim (one line):** The number that defines a voice engine is voice-to-voice (v2v) latency — the wall-clock gap from the user's *end of statement* to the agent's *start of statement* — not any single component's speed.

**Detail.** Vapi defines its core metric as "latency-to-response = duration between user's **end of statement** and agent's **start of statement**" (vapi-latency). Modal calls it "the duration from user stops speaking to first hearing the bot" and notes natural conversation v2v can be as short as **100ms**, while apps target **~1 second or less** (modal-v2v). Because the metric spans STT→LLM→TTS plus network, optimizing one stage in isolation is meaningless; the budget is shared (see [[LAT-04-turn-budget-split]]). LiveKit instruments this directly: `EOUMetrics.end_of_utterance_delay` measures "time between the end of speech from VAD and the decision to end the user's turn" (`metrics/base.py:94-99`), and the per-stage LLM/TTS metrics ([[LAT-02-per-stage-metrics]]) sum into the perceived gap. Modal measures it empirically by recording the full conversation and using Pyannote diarization to find each speaker's turn boundaries, then aggregating v2v across the eCDF (modal-v2v).

**Prior-art divergence.** Vapi frames v2v as *turn-taking* latency and budgets it per-turn (1200ms, [[LAT-03-latency-ladder]]); Modal frames it as a distributed-systems problem (machines spread across DCs) and attacks it with co-location ([[LAT-08-network-vs-engine-colocation]]). Together frames the same number as the hard real-time constraint that forces every downstream model-size and engine choice.

**Implication for Syrinx.** Pick v2v as the top-line SLO and measure it end-to-end (mic-to-speaker, including hardware), not as a sum of provider-reported component latencies. Build the Pyannote-style offline harness early.

Links: [[LAT-02-per-stage-metrics]] [[LAT-03-latency-ladder]] [[LAT-04-turn-budget-split]] [[LAT-12-tail-latency]] [[wiki/lat-map]]
