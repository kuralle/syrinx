# Syrinx Voice Engine — Build Kanban

> **Master document:** [`../PRODUCTION-CHECKLIST.md`](../PRODUCTION-CHECKLIST.md). Every card's detail lives there (Tier-0/Tier-1, exact numbers, canonical `file:line`, pseudocode). Read the relevant § before starting a card. Operating rules: [`MASTER.md`](./MASTER.md).

Move a card by editing this file (cut/paste the row between columns) and the issue's `**Status:**` line.

## 📋 Backlog
| ID | Slice | Tier | Type | Blocked by |
|----|-------|------|------|-----------|
| [VE-03](issues/VE-03-barge-in.md) | Barge-in / interruption | T0 | AFK | VE-01, VE-02 |
| [VE-04](issues/VE-04-telephony-leg.md) | Telephony leg (PSTN/SIP) | T0 | AFK | VE-01 |
| [VE-05](issues/VE-05-latency-metrics.md) | Latency budget & per-stage metrics | T0 | AFK | VE-01 |
| [VE-06](issues/VE-06-reliability.md) | Reliability | T0 | AFK | VE-01 |
| [VE-07](issues/VE-07-observability.md) | Observability & SLOs | T0 | AFK | VE-05 |
| [VE-08](issues/VE-08-tier1-hardening.md) | Tier-1 hardening | T1 | mix | VE-02, VE-03 |
| [VE-09](issues/VE-09-greenfield-gaps.md) | Greenfield gaps (design-first) | GF | HITL | VE-05, VE-07 |

## 🟢 Ready
| ID | Slice | Tier | Type | Blocked by |
|----|-------|------|------|-----------|
_(empty)_

## 🔨 In Progress
_(empty)_

## 🔍 In Review
_(empty)_

## ✅ Done
| ID | Slice | Tier | Type | Blocked by |
|----|-------|------|------|-----------|
| [VE-00](issues/VE-00-gap-analysis.md) | **Gap analysis — reconcile checklist vs Syrinx code** | Foundation | HITL | none |
| [VE-01](issues/VE-01-audio-round-trip.md) | **End-to-end audio round-trip (tracer bullet)** — providers current, AudioFormat contract, ready-frame targetFrameDurationMs, live 3-turn v2v (commits 48b9e0e→ee2936d) | T0 | AFK | VE-00 |
| [VE-02](issues/VE-02-turn-taking.md) | **Turn-taking & endpointing** — single-owner invariant (dedup guard), four-state VAD, EOU budget metrics (commits bed7bb7, 2e21f7a, e6e0567) | T0 | AFK | VE-01 |

---

## Dependency graph
```
VE-00 (gap analysis)
  └─> VE-01 (audio round-trip, tracer bullet)
        ├─> VE-02 (turn-taking) ──> VE-03 (barge-in) ─┐
        ├─> VE-04 (telephony)                         ├─> VE-08 (Tier-1 hardening)
        ├─> VE-05 (latency metrics) ──> VE-07 (obs) ──┴─> VE-09 (greenfield gaps)
        └─> VE-06 (reliability)
```

## Suggested sprints (sequence the columns)
- **Sprint 0 — Foundation:** VE-00. Gate: GAP-ANALYSIS.md reviewed; VE-01..09 re-scoped to real gaps. **Do not start build slices until this is done.**
- **Sprint 1 — Tracer bullet:** VE-01 alone. Gate: a measured end-to-end v2v number.
- **Sprint 2 — Core fan-out (parallel):** VE-02, VE-04, VE-05, VE-06.
- **Sprint 3:** VE-03 (after VE-02), VE-07 (after VE-05).
- **Sprint 4 — Hardening:** VE-08.
- **Sprint 5 — Differentiation:** VE-09 (RFC each sub-item first).
