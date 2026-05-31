# Sprint 01 — Kanban Board

> **External review track:** after each wave (~2 issues) lands, an independent Gemini
> (`agy`) review of that wave's **committed** commits is fired, appending to
> `GEMINI-EXTERNAL-REVIEW.md`. The orchestrator does NOT read these mid-sprint (keeps
> it unbiased) — read holistically at sprint end. Fired so far: `gemini-review-w0` (WT-02, WT-05).

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
- **VE-01** (P2) Semantic endpointing off STT encoder _(Wave 2 — voice-core, holds until VE-04 lands)_
- **VE-02** (P2) Speaker-attribution barge-in _(Wave 2 — voice-core)_
- **VE-03** (P3) Latency-hiding filler token _(Wave 2 — voice-core)_
- **VE-05** (P3) EVA-Bench CI gate

## ⛔ Blocked (waiting on a dependency)
- **WT-03** (P1) Browser pacing + playout clock + jitter buffer → deps: WT-01, WT-02
- **WT-04** (P1) Graceful drain on shutdown → deps: WT-01
- **WT-06** (P2) `SessionStore` interface → deps: WT-01
- **WT-07** (P2) `ClientTransport` seam + Opus browser leg → deps: WT-05 ✅, WT-02 ✅ (unblocks when WT-01 lands)
- **WT-08** (P2) Concurrency cap + admission + upgrade-leak → deps: WT-01
- **WT-09** (P2) Metrics + per-turn timestamps + loss/jitter smoke → deps: WT-01, WT-03

## 🔨 In Progress
- **WT-01** (P1) Extract `WebSocketTransportHost` — Sonnet worker `wt-01` (Wave 1)

## 👀 In Review (tests green, awaiting diff review)
- **VE-04** (P1) Word-level-timestamp context alignment (G2) — worker `ve-04`. `tts.word_timestamps` from Cartesia (cumulative offset), bridge precision ladder (word ts + playout pos → exact; fallback text-to-TTS), 3 new bridge tests (exactness/fallback/deadlock-regression), 1 new Cartesia test. `pnpm -r typecheck && pnpm -r test` green.

## ✅ Done (diff reviewed + behavior observed)
- **WT-02** (P1) Canonical audio module + anti-aliased resampler — worker `f08d4db` + reviewer `7c1ebc2`. Diff read; real windowed-sinc anti-alias (spectral lock ≥40 dB); zero codec re-declarations; all 4 transports on `@asyncdot/voice/audio`; 87 voice + 117 transport tests green; recorder coherence live smoke `qualityGate.passed:true` with new resampler. **Reviewer caught worker's over-claim** (a 1/3-flaky drain test), root-caused it (per-call FIR rebuild load + fixed-wait test), fixed both (FIR memoization + condition-poll) → suite 8/8 stable.
- **WT-05** (P1) Browser client reconnect + resume + keepalive — worker `ed81306` + reviewer flap-guard `190f2fd`. Diff read; 32 unit pass; live headless smoke `resumed:true`, `reconnectUrlHasSessionId:true`, event order verified. Reviewer added `minStableMs`/`maxQuickFailures` quick-failure guard.

---

### Burndown
14 issues · **2 done (WT-02, WT-05)** · 1 in review (VE-04) · 1 in progress (WT-01) · 4 ready · 6 blocked.

