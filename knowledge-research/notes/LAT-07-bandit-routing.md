---
id: LAT-07
title: Bandit exploit/explore routing across volatile provider endpoints
domain: LAT
tags: [latency, routing, bandit, exploration, volatility]
sources: [vapi-latency]
code_refs: []
---

**Claim (one line):** Provider latency is volatile and per-deployment-independent, so you route with a multi-armed bandit — exploit the currently-fastest endpoint with the majority of traffic while exploring the rest with a small statistically-significant slice.

**Detail.** Vapi tracked GPT-4o-mini over 7 days: "A model that performs well Friday night can be unusable Monday morning… **This volatility is the real enemy.**" The same pattern held across all Azure OpenAI regions, varying **independently** (vapi-latency). Their progression:
1. **Brute-force race** — send every request to all 40+ deployments, take the first: latency-optimal but **40× token cost**, unacceptable.
2. **Polling** — probe each deployment every 10 min with a cheap single-token request (~$400/day), cache fastest in Redis: cheaper but suffered **5+ min spikes** when a deployment degraded *between* polls (stale data).
3. **Live data + exploration** — update the proxy list from *live production* request latencies → detect a spike on the next request and rotate out. This created an exploit-only failure (only known winners get traffic, the other 39 go unmeasured), fixed by **segmenting traffic: majority → current fastest (exploit), small statistically-significant subset → test others (explore)** — a multi-armed bandit.

**Prior-art divergence.** No OSS clone implements bandit routing; LiveKit's `FallbackAdapter` is ordered-list failover, not exploit/explore ([[LAT-06-hedged-requests]]). Bandit routing + hedging are complementary: routing picks the *expected* fastest, hedging catches the *individual* request that hangs anyway.

**Implication for Syrinx.** If we multi-home an LLM across regions/providers, route with a bandit fed by live per-request latency, and reserve an exploration slice so a recovered endpoint is re-discovered. Polling alone goes stale; brute-force is too expensive.

Links: [[LAT-06-hedged-requests]] [[LAT-12-tail-latency]] [[LAT-02-per-stage-metrics]] [[wiki/lat-map]]
