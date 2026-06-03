---
id: LAT-03
title: The human latency ladder (300 / 500 / 1200 / 1000-2000 ms)
domain: LAT
tags: [latency, human-factors, budget, perception]
sources: [together-talk, vapi-latency, modal-v2v]
code_refs: []
---

**Claim (one line):** Human conversational perception sets fixed latency thresholds — natural ~300ms, noticeable >500ms, flow-break ~1200ms, hang-up 1–2s — and these (not engineering targets) define the v2v budget.

**Detail.** Together's ladder (together-talk): humans respond to each other's cues in ~**300ms**; if the AI takes >**500ms** "you notice"; **1–2s → people hang up**. Vapi adds the flow-break rung: "conversational flow breaks when latency exceeds **~1200ms**" — described as "the rough time it takes for the user to have a tangential thought" — and hard-codes it as a **1200ms latency budget per turn** (vapi-latency). Modal notes the natural-conversation floor can be as low as **100ms** v2v but apps realistically target **~1s or less** (modal-v2v). The rungs compound: a system that hits 1200ms *on average* but has a tail past 2s ([[LAT-12-tail-latency]]) still triggers hang-ups, because the ladder is read per-turn, not on the mean.

**Prior-art divergence.** Vapi treats 1200ms as a *budget to allocate* ("save ms in LLM reasoning → spend on higher-fidelity TTS"). Together treats the ladder as a *constraint that forces model-size choices upstream* (8–30B LLM, [[LAT-05-ttft-target-model-size]]). Modal's ~1s target is stricter than Vapi's 1200ms because Modal is benchmarking against proprietary services' median.

**Implication for Syrinx.** Adopt 1200ms as the per-turn ceiling and ~1s as the target median; treat 500ms as the "noticeable" line for quality-of-experience alerts. Budget allocation is a product decision (TTS fidelity vs LLM headroom), so make the split configurable.

Links: [[LAT-01-v2v-figure-of-merit]] [[LAT-04-turn-budget-split]] [[LAT-12-tail-latency]] [[wiki/lat-map]]
