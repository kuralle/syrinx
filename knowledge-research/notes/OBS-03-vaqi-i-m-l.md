---
id: OBS-03
title: VAQI — quantifying conversational flow with Interruptions, Missed-responses, Latency
domain: OBS
tags: [observability, vaqi, evaluation, interruptions, barge-in, metrics]
sources: [deepgram-ebook]
code_refs: [agents/livekit-agents/livekit/agents/metrics/base.py:166, agents/livekit-agents/livekit/agents/voice/agent_activity.py:2769]
---

**Claim (one line):** Deepgram's Voice Agent Quality Index reduces "does it *feel* natural" to three timestamp-derived numbers — Interruptions (I), Missed-responses (M), Latency (L) — all computable offline from the same turn-boundary event log.

**Detail.** VAQI definitions (deepgram-ebook line 962–971): **I** = how often the agent speaks before the user finishes; **M** = how often the agent fails to respond within a defined window after a turn ends; **L** = UserStoppedSpeaking→AgentStartedSpeaking elapsed time. "These metrics are derived directly from event timestamps, making them well suited for automated testing" (line 972–974). Telephony's parallel scorecard names the same family operationally: end-of-turn→first-audio latency, **barge-in success rate**, frequency of clipped/interrupted responses, and call-abandonment-during-silence (deepgram-ebook line 775–779). VAQI improvements "correlate strongly with perceived experience," and teams "see measurable gains after tuning end-of-turn thresholds or optimizing orchestration latency" (line 973–975). The clones supply the raw counters: LiveKit's `InterruptionMetrics` carries `num_interruptions`, `num_backchannels`, `detection_delay`, `prediction_duration` (`metrics/base.py:166–181`) — a direct source for **I** and for distinguishing a real barge-in from a backchannel; **L** is the `e2e_latency` already computed at `agent_activity.py:2769`. **M** (silence/stall) maps to Deepgram's production signal "Silence or stall detection, where expected responses fail to arrive within defined time windows" (line 1047).

**Prior-art divergence.** Deepgram defines VAQI as a *named composite index* and pairs it with Coval for large-scale probabilistic scoring (line 966–969). LiveKit/Pipecat ship the *constituent raw counters* (`InterruptionMetrics`, e2e latency) but no rolled-up index — the aggregation into I/M/L bands is left to the operator. Notably `num_backchannels` exists specifically so backchannels ("uh-huh") aren't miscounted as failed interruptions, a refinement VAQI's bare "I" doesn't articulate.

**Implication for Syrinx.** Adopt I/M/L as the release-gate triad, but compute **I** from interruption events *minus backchannels* (LiveKit's split), and define **M**'s "window" explicitly per deployment. Track barge-in success rate and clipped-response frequency as the telephony-side projection of the same data.

Links: [[OBS-02-canonical-timing-metric]] [[OBS-06-slos-percentiles-tail]] [[OBS-09-replay-load-fault-injection]] [[BARGE-06-confidence-gated-interruption]]
