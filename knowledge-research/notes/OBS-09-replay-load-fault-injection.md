---
id: OBS-09
title: Reliability testing — replay, load/stress on tail, fault injection, turn-level diagnostics
domain: OBS
tags: [observability, testing, replay, load-test, fault-injection, evaluation]
sources: [deepgram-ebook, modal-v2v]
code_refs: [agents/livekit-agents/livekit/agents/voice/audio_recognition.py:1185, agents/livekit-agents/livekit/agents/metrics/base.py:166]
---

**Claim (one line):** Voice agents are probabilistic, so reliability is *measured as a distribution*, not asserted — the standard toolkit is probabilistic regression, replay testing (hold input constant), load/stress on **tail** latency, fault injection, and turn-level diagnostics that overlay interruption events on the UserStopped→AgentStarted timeline.

**Detail.** Deepgram: "Traditional QA assumes identical inputs yield identical outputs. Voice agents violate this by design" (deepgram-ebook line 972–974) → the goal is "measure outcome distributions and improve their consistency" (line 953–955). The five methods (line 992–997, 979–983):
- **Probabilistic regression** — many sessions under varied accents/noise/cadence; compare metric distributions across versions to detect drift.
- **Replay testing** — "Reprocess recorded audio through new builds to isolate timing regressions while holding input constant."
- **Load and stress testing** — "Simulate concurrent sessions and track **tail latency rather than averages**."
- **Fault injection** — "Introduce controlled failures such as delayed reasoning or dropped synthesis to confirm graceful recovery."
- **Turn-level diagnostics** — "Visualize UserStoppedSpeaking to AgentStartedSpeaking intervals and overlay interruption events to pinpoint orchestration bottlenecks."

Releases gate on tolerance bands (max acceptable VAQI deltas / missed-response rates) over a fixed library of representative test calls (line 984–986, 1007–1008). Modal demonstrates the offline-measurement pattern: record the conversation client-side and run **Pyannote (Precision-2)** diarization to recover each speaker's turn boundaries, then compute v2v latency eCDFs across deployments (modal-v2v line 46–47) — a reusable replay/regression harness. The clones supply the diagnostic substrate: LiveKit's per-turn timestamps + `InterruptionMetrics` (`metrics/base.py:166`) are exactly the overlay data for turn-level diagnostics, and its "refuse to compute on unreliable VAD" rule (`audio_recognition.py:1185`) keeps the distribution clean.

**Prior-art divergence.** Deepgram outsources large-scale probabilistic/semantic eval to **Coval** (line 968,984,991); Modal builds a bespoke diarization-based harness; the OSS clones ship the per-turn telemetry but no test harness — testing is the operator's. Replay (constant input) isolates *engine* regressions; probabilistic regression (varied input) surfaces *robustness* regressions — they're complementary, not substitutes.

**Implication for Syrinx.** Build (a) a replay harness that re-runs recorded audio through new builds and diffs the latency/VAQI distribution, (b) a load test asserting on P95/P99 not mean, (c) fault injection for delayed-reasoning / dropped-synthesis recovery, and (d) a turn-diagnostic view overlaying interruptions on the UserStopped→AgentStarted timeline. Gate releases on tolerance bands.

Links: [[OBS-02-canonical-timing-metric]] [[OBS-03-vaqi-i-m-l]] [[OBS-06-slos-percentiles-tail]] [[OBS-10-synthetic-real-user-monitoring]] [[OBS-09-replay-load-fault-injection]] [[TURN-01-vad-state-machine-hysteresis]]
