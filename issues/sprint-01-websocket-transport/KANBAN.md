# Sprint 01 — Kanban Board

Move a card right as it progresses. A card enters **Review** only with green
unit tests + a live-API smoke (where applicable) + updated docs. It enters
**Done** only after the reviewer has read the actual diff (ship-it-managed
Phase 3) and observed the behavior end-to-end.

Legend: `WT` = WebSocket transport · `VE` = voice engine · `(Pn)` priority ·
`→deps` blocked-by.

---

## 📥 Backlog
_(empty — all sprint issues are specced and promoted to Ready/Blocked)_

## 🟢 Ready (unblocked, can start now)
- **VE-04** (P1) Word-level-timestamp context alignment (completes G2)
- **VE-01** (P2) Semantic endpointing off STT encoder
- **VE-02** (P2) Speaker-attribution barge-in
- **VE-03** (P3) Latency-hiding filler token
- **VE-05** (P3) EVA-Bench CI gate

## ⛔ Blocked (waiting on a dependency)
- **WT-01** (P1) Extract `WebSocketTransportHost` → deps: WT-02
- **WT-03** (P1) Browser pacing + playout clock + jitter buffer → deps: WT-01, WT-02
- **WT-04** (P1) Graceful drain on shutdown → deps: WT-01
- **WT-06** (P2) `SessionStore` interface → deps: WT-01
- **WT-07** (P2) `ClientTransport` seam + Opus browser leg → deps: WT-05, WT-02
- **WT-08** (P2) Concurrency cap + admission + upgrade-leak → deps: WT-01
- **WT-09** (P2) Metrics + per-turn timestamps + loss/jitter smoke → deps: WT-01, WT-03

## 🔨 In Progress
_(none)_

## 👀 In Review (tests green, awaiting diff review)
- **WT-02** (P1) Canonical audio module + anti-aliased resampler — typecheck clean, 117 transport tests + 21 audio unit tests green; emulator smokes (twilio/telnyx/smartpbx) pass; recorder coherence smoke `qualityGate.passed:true`; spectral test ≥40 dB alias suppression confirmed

## ✅ Done (diff reviewed + behavior observed)
- **WT-05** (P1) Browser client reconnect + resume + keepalive — worker `ed81306` + reviewer flap-guard `190f2fd`. Diff read; 32 unit pass; live headless smoke `resumed:true`, `reconnectUrlHasSessionId:true`, event order verified. Reviewer added `minStableMs`/`maxQuickFailures` quick-failure guard (worker reset attempt on every open → flap loop).

---

### Burndown
14 issues · 0 done · 1 in review · 1 in progress · 5 ready · 7 blocked.
