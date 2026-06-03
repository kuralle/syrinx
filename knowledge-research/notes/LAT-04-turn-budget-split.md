---
id: LAT-04
title: Splitting the per-turn budget — ASR 300 / LLM 200-900 / TTS 400, LLM dominates
domain: LAT
tags: [latency, budget, asr, llm, tts, allocation]
sources: [diagrams, vapi-latency, together-talk]
code_refs: []
---

**Claim (one line):** Within the ~1200ms turn budget the LLM is the dominant and *variable* term; STT and TTS are roughly fixed — so latency work is mostly LLM work.

**Detail.** Vapi's hand-drawn budget diagram (diagrams, `vapi-latency-budget.png`): waveform → **ASR 300ms** → **LLM 200–900ms** → **TTS 400ms** → waveform. STT (~300ms) and TTS (~400ms) are roughly fixed; the LLM is the 200–900ms swing term. Vapi's prose confirms: "ASR (STT) and TTS are fairly optimized by providers. **The bottleneck is almost always the LLM** — specifically time-to-first-meaningful-sentence" (vapi-latency). Together gives the same ordering as a rule of thumb for both latency *and* cost: "**LLM majority > TTS > STT**" (together-talk). The implication is that brute-forcing TTS or STT yields little; the leverage is in LLM TTFT ([[LAT-05-ttft-target-model-size]]), hedging volatile LLM endpoints ([[LAT-06-hedged-requests]]), and removing the LLM from the *perceived* critical path via speculation ([[LAT-09-preemptive-generation]], [[LAT-10-predict-and-scrap]]).

**Prior-art divergence.** Vapi's split assumes a *cascaded* pipeline where the LLM blocks TTS; speech-to-speech (S2S) models collapse STT+LLM+TTS into one forward pass and change the arithmetic entirely (together-talk notes S2S is not yet production-ready for tool-calling). ElevenLabs claims its *orchestration overhead* is <100ms on top of the model times (el-orchestration) — i.e. the framework should be a rounding error against the 1200ms, not a line item.

**Implication for Syrinx.** Instrument the three stages separately ([[LAT-02-per-stage-metrics]]) and expect the LLM to own >50% of a turn. Spend optimization effort on LLM TTFT and on masking it (filler speech [[LAT-11-filler-speech]], preemption), not on shaving STT/TTS.

Links: [[LAT-03-latency-ladder]] [[LAT-05-ttft-target-model-size]] [[LAT-02-per-stage-metrics]] [[LAT-11-filler-speech]] [[wiki/lat-map]]
