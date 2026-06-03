# VE-07 — Observability & SLOs

**Type:** AFK · **Tier:** Tier-0 · **Status:** Done (v2 — af3108c, cd7727a, 2a83b49; OTel backend = optional impl pkg; see .handoff/session-ve07-observability-close.md)
**Master document:** [`../../PRODUCTION-CHECKLIST.md`](../../PRODUCTION-CHECKLIST.md) → **§8 Observability**

## What to build
One canonical event + metric backbone so every quality/latency signal derives from the same raw turn-boundary events, with SLOs and correlation for incident drill-down.

## Acceptance criteria
- [ ] One canonical turn-boundary event stream (UserStartedSpeaking, UserStoppedSpeaking, AgentThinking, AgentStartedSpeaking, AgentAudioDone, interruption, tool lifecycle) with monotonic timestamps + session ids.
- [ ] Per-stage histograms + traces tagged with session-id / speech-id / request-id / provider / model / region (Prometheus for SLOs, OTel spans conversation→turn→stage).
- [ ] VAQI constituents tracked (interruptions counted separately from backchannels; missed responses; latency) even before defining the rollup formula.
- [ ] SLOs expressed on latency percentile, interruption-handling success, error rate; alerts on sustained deviation.

## Demo / verify
A real incident can be reconstructed end-to-end from one session id across logs/metrics/traces; SLO dashboards show P95 v2v, barge-in success, error rate.

## Blocked by
VE-05.

## Key references
notes: OBS-01..11; wiki/obs-map.

## Current state (Syrinx)
Bus packet/debug streams, browser turn metrics, and VAQI constituents exist, but not a typed canonical observability stream with tagged histograms, OTel spans, SLOs, alerts, synthetic probes, or RUM. See [`../reconcile/VE-07-bridge.md`](../reconcile/VE-07-bridge.md).
