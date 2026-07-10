# Outcomes — InteractionPolicy seam + VAP

## 2026-07-10 continuation — C1–C6 built (C1b deferred)

Every RFC chunk except C1b is now built + manager-verified. **C1+C2 merged to `beta`** (PR #25, `fcead10`).
**C3 + C4 + C5 + C6 are on `plan/ip-vap`** (off the merged lineage), awaiting a batch PR into `beta` (outward
gate — human go).

| Chunk | State | Commits |
|-------|-------|---------|
| C1 seam + RuleBasedInteractionPolicy (barge-in) | ✅ merged to beta | a53f2d2 + 55d098a |
| C2 caps + DeferInteractionPolicy | ✅ merged to beta | 37fa3f2 + f139481 |
| C4 rich STT seam (wordTimings) | ✅ on plan/ip-vap | 90b64ca |
| C5 @kuralle-syrinx/vap VapInteractionPolicy | ✅ on plan/ip-vap | be30a75 + 3588e47 |
| C3 backchannel wait-gap cue layer (reshaped) | ✅ on plan/ip-vap | 328db80 + 3c9c149 |
| C6 eval harness (task-success + config matrix) | ✅ on plan/ip-vap | 4c91843 |
| C1b endpointing behind the seam | ⏸ deferred → do with half-cascade | — |

**C3** was reshaped per a codex research decision (`research/interaction-policy/c3-backchannel-decision.md`):
a conservative asset-backed wait-gap cue layer composing with the v4.1 thinking bed (one cue on the G3
`delayed` phase, no user-pause backchannels, byte-based CF-neutral cues, `caps.emitsBackchannel` gating);
free-form tool-call filler fields explicitly rejected. **C5** ships turn-scoped VAP behind the seam with a
correct sync-observe/async-inference split and a CF-correct Workers predictor, honestly `StubVapPredictor`-
backed (no open ONNX VAP checkpoint exists upstream). **C6** builds the RFC §9.4 proof-gate infrastructure
(task-success scorer + config matrix + verdict rule, reusing the shipped Full-Duplex-Bench scorer).

**Known follow-ups (documented, not silent):**
- **VAP not yet reachable end-to-end** — needs an `interactionPolicy` session-injection + `audio_frame`/
  `playout_tick` observation feeds (scoped in `C6-eval-harness-design.md`). Until then the eval matrix's
  `cascade+VAP` rows are gated.
- **No real VAP ONNX model** (upstream PyTorch-only) — export needed; the placeholder `RollingFeatureBuffer`
  has an O(n²) append + a feature-aliasing hazard to fix at that point (see `packages/vap/README.md`).
- **C3 real voice-matched cues + listen-smoke** (placeholders now).
- **`pnpm -r test` flake** — `packages/grok` STT test flakes under full-parallel load (passes isolated); a
  pre-existing CI risk, not from this work.
- The **live eval sweep** (examiner × configs) is a manager-run smoke, gated on the VAP wiring + real model.

---

## (original) Status: the seam foundation (C1 + C2)

**Status:** the **seam foundation (C1 + C2) is built + manager-verified** on `plan/interaction-policy`
(off `beta`), behavior-preserving. C3–C6 + C1b are scoped below with honest gating. Not yet PR'd into
`beta` (outward-facing gate — awaiting human go).

## Shipped + verified (this cycle)

### C1 — the barge-in seam (commit `a53f2d2` + manager guard `55d098a`)
- New `packages/core/src/interaction-policy.ts` (`InteractionPolicy` / `InteractionObservation` /
  `InteractionDecision` / `WordTiming`), `interaction-coordinator.ts`, `policies/rule-based.ts`.
- `TurnArbiter` gains an optional **interrupt sink** (absent → today's `bus.push(interrupt.detected)`,
  byte-identical; present → routes the autonomous-commit decision to the sink). `RuleBasedInteractionPolicy`
  wraps the arbiter with that sink and exposes `observe()→Decision[]`. `InteractionCoordinator` maps
  `interrupt → arbiter.emitInterruptDetected`. The session drives the coordinator via `observe(...)`
  instead of the arbiter directly; the arbiter is reduced to the executor.
- **Behavior-preserving:** `turn-arbiter.test.ts` + `turn-arbiter.characterization.test.ts` + the existing
  session barge-in suite pass **byte-unchanged**. A future `VapInteractionPolicy` returns the same
  `interrupt` decisions through the same executor → the seam is real.
- **Manager verify = PROCEED:** re-ran core typecheck+test (exit 0); read the hunks (surgical; sink wired
  right; no double-drive — only `clear`/`commitClientInterrupt`/`emitInterruptDetected` executor calls
  remain; gating + push-ordering preserved; the deferred-audio commit handled via a `bargeInAudioConsumed`
  flag). Added a session-level **provider-STT backchannel-suppression** regression guard (the one path the
  6 unit tests + the commit test didn't cover). Detail: `proceed-C1.md`.

### C2 — capability negotiation + defer (commit `37fa3f2` + manager guard `f139481`)
- `RealtimeAdapter.caps` gains `supportsFullDuplex?` / `emitsBackchannel?` (additive, optional).
- New `packages/core/src/policies/defer.ts` — `DeferInteractionPolicy` (`observe → []`, `reset` noop).
- Session config `fullDuplex?` selects the coordinator's **drive** policy = Defer (observe-only) while the
  **executor** stays the rule policy's arbiter — so VAD/STT-driven decisions are suppressed but the direct
  client interrupt still works.
- **Manager verify = PROCEED:** core 253 + realtime 51 green, both typechecks 0, guard tests unchanged.
  Risk checked both directions: grok's test proves observe-only suppression; a manager guard proves a
  direct `requestClientInterrupt` STILL fires in defer mode. Detail: `proceed-C2.md`.

**Test baseline moved 241 → 253 core (all green); realtime 51 green.** Every chunk behavior-preserving;
no existing characterization test edited.

## Remaining — honest gating (why each is not built this cycle)

- **C1b — endpointing owners behind the seam (`take_turn`).** The endpointing owners emit
  `eos.turn_complete` via **plugins/finalizers**, not a session decision — making the policy *emit*
  `take_turn` means replacing those finalizers (large, telephony-sensitive). The minimal version (relocate
  the owner-identity string) is near-cosmetic. Its real consumer is **half-cascade's `take_turn`**
  (text-only front degrades native turn detection). → do it **with half-cascade**, guarded by the existing
  `endpointingOwner`-invariant suite (`voice-agent-session.test.ts` 2440+).
- **C3 — backchannels.** Two unresolved items: (1) **product fork the RFC doesn't resolve** — the
  rule-based backchannel *trigger* is specified only for VAP (pseudocode), and its relationship to the
  **already-shipped v4.1.0 thinking bed** (`wireBackgroundThinking`, which already plays audio during the
  exact delegate gap) is unspecified (discrete "mhmm" vs ambient loop; how they compose / avoid double
  audio). (2) **Missing assets** — RFC Q2 wants a pre-cached PCM cue set ("mhmm"/"got it" per voice); none
  exist in the repo. Buildable with a chosen default trigger + placeholder cue PCM + a render smoke, but the
  product decision + assets should land first. Wiring is understood: `delegate.query`/`delegate.result`
  bound the gap (aisdk `index.ts:349/500`, realtime `realtime-bridge.ts:317/384`); render via
  `BackgroundAudioMixer` (`server-websocket/background-audio.ts`) + `cf-agents/with-voice.ts` on both transports.
- **C4 — rich `SttPartialPacket` (wordTimings).** Purely additive plumbing whose only consumer is C5's VAP
  (`wordTimings` in `observe`). **No present consumer** → build with C5 (YAGNI / build-for-one).
- **C5 — `@kuralle-syrinx/vap` VapInteractionPolicy.** Large (new ONNX package + checkpoint). The seam it
  slots behind is now built (C1). **Turn-scoped VAP is buildable; the full-duplex no-boundary mode is
  BLOCKED on B-05** (`contextId → turn-epoch` reshape — confirmed: base packets carry only
  `contextId`+`timestampMs`, epoch lives only inside aisdk IU objects). Own-session effort.
- **C6 — eval harness (proof gate).** Independent, large; measures the config matrix. Own-session effort;
  the thesis-proof gate the RFC gates the whole claim on.

## Next-session pickup
`get_next_task` is unreliable here (two active goals — drive from `list_tasks`). The seam foundation is in;
the natural next moves are **C3 once the backchannel product fork + cue assets are decided**, or **C5 VAP
turn-scoped** (the seam is ready), or **half-cascade** (pulls C1b along). PR `plan/interaction-policy`
(C1+C2) into `beta` when the human approves the outward gate.
