---
id: LAT-06
title: Hedged requests with a per-endpoint dynamic timeout (mean + kσ)
domain: LAT
tags: [latency, hedging, tail-latency, fallback, timeout]
sources: [vapi-latency]
code_refs: [agents/livekit-agents/livekit/agents/llm/fallback_adapter.py:45]
---

**Claim (one line):** Silent provider hangs (no error, no timeout) are killed by hedging — cancel a too-slow request and immediately fire the next-fastest endpoint — with the "too slow" threshold computed *per endpoint* as mean + k·σ of its own latency history.

**Detail.** Vapi's "real problem": even after dynamic routing, ~**5% of turns hung up to 5000ms** because "sometimes a request to a provider just hangs — no error, no timeout, nothing" (vapi-latency). The fix: "if a request to the fastest deployment takes too long, **cancel it and immediately fire a new request to the second-fastest**." A single global threshold fails because each deployment has its own profile, so they "compute **historical standard deviation per deployment**, set a **dynamic threshold based on what constitutes abnormal latency for that specific deployment**" (i.e. mean + k·σ). Outlier → fall back to second; second outlier → third; etc. "**This system alone shaved >1000ms off P95 latency.**" This is classic request hedging applied per-endpoint and gated on the endpoint's own tail.

**Prior-art divergence.** LiveKit's `FallbackAdapter` is the OSS analog but **simpler and static**: a fixed `attempt_timeout: float = 5.0` per LLM attempt (`fallback_adapter.py:45,71,175`), with `max_retry=0` so it fails over rather than retrying the same endpoint (`fallback_adapter.py:17-18`), plus a background `recovering_task` that probes a downed provider before returning it to rotation (`fallback_adapter.py:25,154-199`). It is *failover on hard timeout/error*, not *latency hedging on a per-endpoint σ threshold* — it would not catch Vapi's "5000ms hang under a 5s timeout" case until the full 5s elapsed. No clone implements the mean+kσ dynamic threshold.

**Implication for Syrinx.** Plain failover-on-error is insufficient; we need latency hedging keyed to each endpoint's measured σ (built on [[LAT-02-per-stage-metrics]]). Tune k to balance extra cost (too aggressive) vs user wait (too slow). Optimize for P95/P99, not mean ([[LAT-12-tail-latency]]).

Links: [[LAT-07-bandit-routing]] [[LAT-12-tail-latency]] [[LAT-02-per-stage-metrics]] [[REL-08-fallback-adapter-availability]] [[wiki/lat-map]]
