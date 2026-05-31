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

## 🟢 Ready (unblocked — transport track shipped sequentially, in order)
- **WT-06** (P2) `SessionStore` interface
- **WT-07** (P2) `ClientTransport` seam + Opus browser leg
- **WT-08** (P2) Concurrency cap + admission + upgrade-leak
- **VE-01** (P2) Semantic endpointing off STT encoder _(engine track, after WT)_
- **VE-02** (P2) Speaker-attribution barge-in _(engine track)_
- **VE-03** (P3) Latency-hiding filler token _(engine track)_
- **VE-05** (P3) EVA-Bench CI gate

## ⛔ Blocked (waiting on a dependency)
- **WT-09** (P2) Metrics + per-turn timestamps + loss/jitter smoke → deps: WT-03

## 🔨 In Progress
- **WT-03** (P1) Browser pacing + playout clock + jitter buffer — cursor-agent/Sonnet worker `wt-03`

## 👀 In Review (tests green, awaiting diff review)
_(none)_

## ✅ Done (diff reviewed + behavior observed)
- **WT-04** (P1) Graceful drain on shutdown — worker (died on 1M-credit limit) + reviewer `88ce280`. `close({graceful,drainDeadlineMs})` host + per-carrier path (drain→1001→terminate at deadline); SIGTERM wired. 7 graceful-drain tests **12× stable**, full suite 124 green. **Reviewer took ownership** (worker out of credits) + root-caused the flaky browser tests to a `ready`-message race in the TEST (not close); reverted speculative close changes. _(Pre-existing unrelated `index.test.ts` malformed-JSON flake noted for a suite-health pass.)_
- **WT-01** (P1) Extract `WebSocketTransportHost` — worker `40ea8be`. Diff read; lifecycle skeleton lives ONLY in `transport-host.ts` (+ `outbound-playout-pipeline.ts`, `transport-helpers.ts`); zero helper/lifecycle copies in the 4 carriers (twilio 942→522, telnyx 946→630, smartpbx 739→457, index 882→682); no file >1000 lines; **117 transport tests ×5 stable**; Telnyx-reorder/Twilio-reject/SmartPBX-passthrough preserved. **Live gate passed:** Fly synthetic-carrier (Deepgram TTS) E2E green on all 3 carriers (twilio/telnyx/smartpbx `gate=true`, 0 failures), both Fly apps destroyed, no leaks. Clean — no reviewer fixes needed.
- **VE-04** (P1) Spoken-prefix context (closes G2) — worker `5b615b5`. Diff read; `tts.word_timestamps` (Cartesia cumulative offset) + bridge precision ladder; **deadlock regression test verified real** (barge-in mid-playout at 450 ms → history truncates to exactly the heard words). Tests green (voice 87 / bridge 8 / cartesia 11). G2+G25 SHIPPED. ✅ **Live debt CLOSED** with the new Cartesia key: recorder-coherence `qualityGate.passed:true` + `tts.word_timestamps` emitted live. _Investigating the original smoke exposed + fixed a real crash:_ **G27** (`b1950ad`) — `voice-ws` dispose-while-connecting killed the process via an unhandled `'error'` (regression test proven to fail without the fix); hardens every provider plugin.
- **WT-02** (P1) Canonical audio module + anti-aliased resampler — worker `f08d4db` + reviewer `7c1ebc2`. Diff read; real windowed-sinc anti-alias (spectral lock ≥40 dB); zero codec re-declarations; all 4 transports on `@asyncdot/voice/audio`; 87 voice + 117 transport tests green; recorder coherence live smoke `qualityGate.passed:true` with new resampler. **Reviewer caught worker's over-claim** (a 1/3-flaky drain test), root-caused it (per-call FIR rebuild load + fixed-wait test), fixed both (FIR memoization + condition-poll) → suite 8/8 stable.
- **WT-05** (P1) Browser client reconnect + resume + keepalive — worker `ed81306` + reviewer flap-guard `190f2fd`. Diff read; 32 unit pass; live headless smoke `resumed:true`, `reconnectUrlHasSessionId:true`, event order verified. Reviewer added `minStableMs`/`maxQuickFailures` quick-failure guard.

---

### Burndown
14 issues · **5 done (WT-01, WT-02, WT-04, WT-05, VE-04)** + 1 bonus reviewer fix (G27) · 1 in progress (WT-03) · 7 ready · 1 blocked.
Worker note: claude 1M-context usage credits exhausted → remaining workers run on `cursor-agent --model sonnet-4` (Sonnet, Cursor billing).
External review: `gemini-review-w0` + `gemini-review-w1` fired (unread, accumulating in GEMINI-EXTERNAL-REVIEW.md).
Live-verification debt: none open (VE-04 closed via new Cartesia key).

