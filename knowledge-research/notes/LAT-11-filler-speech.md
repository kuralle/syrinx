---
id: LAT-11
title: Pre-tool filler speech masks tool/LLM latency with parallel acknowledgement
domain: LAT
tags: [latency, masking, tool-calling, filler, perceived-latency]
sources: [el-orchestration, together-talk]
code_refs: []
---

**Claim (one line):** When a tool call or slow LLM will blow the turn budget, emit a brief filler acknowledgement ("Let me check that") *in parallel* with the slow work so the user hears speech instead of dead air — masking, not removing, the latency.

**Detail.** ElevenLabs' Immediate-Mode tools are "combined with **pre-tool speech**: the agent first emits a brief acknowledgement ('Let me check that for you') returned to the user **while the tool runs in parallel, minimizing dead air**. For slower tools the platform automatically extends these filler messages to match the expected wait time" (el-orchestration). Together's **thinker–talker pattern** is the same idea at the model level: a small fast LLM "handles the live conversation, emits filler ('let me think about it') + issues one tool call to a much bigger model" whose cleaner response then goes to TTS (together-talk) — the small model fills airtime while the big model (which would otherwise burn the budget, [[LAT-05-ttft-target-model-size]]) works. Filler is a *perceived-latency* technique: the v2v clock to first-audio is met by the acknowledgement even though the substantive answer arrives later.

**Prior-art divergence.** ElevenLabs auto-*sizes* filler to the expected tool wait (so the filler doesn't end before the result arrives, re-introducing dead air); Together routes through two models of different sizes. Both contrast with **post-tool speech** (el-orchestration) for *consequential* actions (transfer, payment) where the user must hear full context and be able to interrupt *before* the action — there, masking is deliberately disabled. This pairs with the rule that guardrails sit *before* TTS because "you can't take back spoken words" (together-talk) — filler is spoken, so it must be safe to say before the result is known.

**Implication for Syrinx.** Support pre-tool filler in Immediate mode, auto-extended to the tool's expected latency, and a Post-tool mode for irreversible actions. Filler buys perceived-latency headroom but is orthogonal to real latency work ([[LAT-09-preemptive-generation]]); use both.

Links: [[LAT-09-preemptive-generation]] [[LAT-04-turn-budget-split]] [[LAT-05-ttft-target-model-size]] [[ARCH-07-thinker-talker]] [[wiki/lat-map]]
