# How we solved latency at Vapi
Source: https://vapi.ai/blog/how-we-solved-latency-at-vapi
Author: Abhishek Sharma, 2025-07-14

**Core metric:** latency-to-response = duration between user's **end of statement** and agent's **start of statement**. This cycle = **turn-taking**.

> IMAGE (hello-image-1.png): turn-taking diagram (user end-of-statement → agent start-of-statement).

**Conversational flow breaks when latency exceeds ~1200ms** ("the rough time it takes for the user to have a tangential thought"). → strict **1200ms latency budget per turn**. Treat budget as scarce resource: save ms in LLM reasoning → spend on higher-fidelity TTS.

> IMAGE (high-latency-often.png): how the 1200ms budget is split across STT + LLM + TTS in a speech-to-speech pipeline.

ASR (STT) and TTS are fairly optimized by providers. **The bottleneck is almost always the LLM — specifically time-to-first-meaningful-sentence.** LLM provider benchmarks rarely hold in production.

Tracked GPT-4o mini over 7 days: latency unstable. "A model that performs well Friday night can be unusable Monday morning." **This volatility is the real enemy.** Same pattern across all Azure OpenAI regions; they vary independently. → Need a system that dynamically routes every request to the fastest deployment available at that exact moment.

> IMAGES (soft-chart.png, wiggly-graph.png): latency time-series volatility.

### Attempt 1: Brute-Force Race
Send every request to all 40+ Azure OpenAI deployments, use first to respond. Latency-optimal but **40x token cost. Unacceptable.**
> IMAGE (brute-force.png).

### Attempt 2: Polling for the Fastest Path
Poll each deployment with a cheap single-token request (O(1) cost). Poll every 10 min (~$400/day). Store results in Redis; on call, pick fastest from Redis. Improved average but **spikes lasting 5+ min** — when a deployment degraded between polls, stuck routing to a slow endpoint for 10 min.
> IMAGE (polling.png): proxy-list accuracy degrades between polls.

### Attempt 3: Live Data + Exploration
Use latency from **live production requests** to update the proxy list in real time → detect spike on next request, rotate out. Solved stale data but created exploit-only problem (only exploiting known winners, not exploring other 39). Fix = **segment traffic: majority → current fastest (exploitation), small statistically-significant subset → test others (exploration)** [multi-armed bandit].
> IMAGES (attempt-3-1/2/3.png).

### The Real Problem
Still ~**5% of turns hung up to 5000ms** ("death spiral"). Cause: **sometimes a request to a provider just hangs — no error, no timeout, nothing.** The first request to hit the hang gets shot; system routes subsequent traffic away but that first user's experience is already ruined.

**Final piece — recovery mechanism / hedged request:** if a request to the fastest deployment takes too long, **cancel it and immediately fire a new request to the second-fastest**. Threshold is tricky (too aggressive = extra cost; too slow = user waits). Each deployment has its own performance profile → **single threshold won't work**. Compute **historical standard deviation per deployment**, set a **dynamic threshold based on what constitutes abnormal latency for that specific deployment**. Outlier → fall back to second; second outlier → third; etc.

> IMAGES (real-problem-1..4.png, happy-ending.png).

**This system alone shaved >1000ms off P95 latency.** "What it takes to make an off-the-shelf model like GPT-4o reliably fast for real-time voice."

## Takeaways for Syrinx
- Per-turn latency budget (~1200ms) as a first-class design constraint.
- Provider latency is **volatile and per-region/per-deployment independent** — route dynamically.
- **Hedged requests with per-endpoint dynamic timeout (mean+k·σ)** to kill silent hangs. Tail latency (P95/P99), not average, is what breaks conversation.
- Bandit-style exploit/explore over provider endpoints.
