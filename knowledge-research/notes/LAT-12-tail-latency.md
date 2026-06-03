---
id: LAT-12
title: Tail latency (P95/P99) is what breaks conversation, not the mean
domain: LAT
tags: [latency, tail, percentile, p95, p99, slo]
sources: [vapi-latency, modal-v2v, together-talk]
code_refs: [agents/livekit-agents/livekit/agents/llm/fallback_adapter.py:154]
---

**Claim (one line):** Conversation breaks on the *tail*, not the average — a good mean with a 5000ms P99 still triggers hang-ups — so every latency lever is measured and tuned against P95/P99.

**Detail.** Vapi's headline win is stated in tail terms: hedging "shaved **>1000ms off P95 latency**," and the problem it solved was "~**5% of turns hung up to 5000ms**" — a pure tail event with a fine mean (vapi-latency, [[LAT-06-hedged-requests]]). The flow-break/hang-up rungs of the ladder ([[LAT-03-latency-ladder]]) are read per-turn, so a single tail turn past 1200ms breaks flow regardless of average. Modal selects the inference engine on "**P95 TTFT, not throughput**" and reports results as **eCDFs** of v2v latency across deployments (not a single mean) precisely to expose the tail (modal-v2v). Together: "every 10ms matters → need deep observability" and scale **up aggressively** so requests never back up — backed-up queues are a tail-latency generator (together-talk). The mechanisms that specifically attack the tail: per-endpoint σ hedging ([[LAT-06-hedged-requests]]), bandit rotation off a spiking endpoint ([[LAT-07-bandit-routing]]), and `FallbackAdapter`'s timeout-triggered failover (`fallback_adapter.py:154-199`, a coarse tail-cut on the 5s timeout).

**Prior-art divergence.** Vapi attacks the tail dynamically (per-endpoint mean+kσ); LiveKit's OSS failover is a *static* 5s cut ([[LAT-06-hedged-requests]]) — it bounds the catastrophic tail but not the 1200–5000ms band. Modal attacks the tail structurally (co-location + engine choice) so the distribution is tight to begin with rather than relying on per-request recovery.

**Implication for Syrinx.** Define SLOs on P95/P99 v2v, not mean. Report latency as eCDFs in dashboards. Every routing/hedging/co-location decision is justified by its effect on the tail, since that is what users actually hang up on.

Links: [[LAT-06-hedged-requests]] [[LAT-07-bandit-routing]] [[LAT-03-latency-ladder]] [[LAT-08-network-vs-engine-colocation]] [[LAT-02-per-stage-metrics]] [[wiki/lat-map]]
