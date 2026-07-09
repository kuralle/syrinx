# Work Breakdown Structure — IU Substrate (Syrinx vNext, Phase 0)

> **The build plan, sprint by sprint, end-to-end.** Spans `docs/rfc-incremental-unit-substrate.md` (the capstone/substrate RFC that reframes speculative generation, eager-EOT, barge-in truncation, and the `contextId → turn-epoch` reshape as one commit/revoke primitive) with academic grounding in `research/incremental-processing-deep-dive.md`. Every sprint is an end-to-end demoable slice, not a horizontal slab. Cadence and engineering practice are the same across all sprints.

> **⚠️ AMENDMENT (2026-07-09, post-Sprint-0):** RFC C5 (standalone turn-epoch reshape) was **rescoped** — see [`docs/rfc-incremental-unit-substrate-amendment-C5.md`](../docs/rfc-incremental-unit-substrate-amendment-C5.md). The telephony P0 bug C5 targeted is **already fixed** in the current tree (v4.1.0 `-t<n>` per-turn rotation + bounded poison sets), and no consumer needs a first-class `epoch`. C5's real value (giving the dormant `IuLedger` a producer + first-class turn identity) folds into **C2**, delivered by its first real consumer. The 15-file `contextId`→session-id split is deferred to backlog B-05 (consumer-gated). **Resequenced roadmap below reflects this.**

---

## 1. Cadence and engineering practice

### 1.1 Cadence
- **1w sprints.** Planning at sprint start, IC execution mid-sprint (Phase A), manager review after every story has proceed evidence (Phase B), warm-down in the last hour.
- **One sprint goal**, expressed as a single sentence with a verifiable outcome.
- **2–5 stories per sprint.** Smaller is better. Each story ships independently.
- **No carry-over.** If a story slips, it goes back to the backlog, not the next sprint as-is. Rewrite the story.

### 1.2 Definition of Done (universal)
A sprint's stories are collectively Done when **all** of the following hold:

1. Every story commits atomically (`[S{N}-{nn}] {title}`) on the **active build branch** (`plan/iu-substrate` — see `sprints/STATE.md` § Build branch) behind a green CI run (the repo's push/PR typecheck + unit-test workflow).
2. Unit tests written for every new exported function / class. **Coverage is not the metric**; *behavioral coverage* is — every public surface tested with at least one happy-path and one failure-path test.
3. **Passes sprint-level manager review (Phase B — after every story has proceed evidence):** manager sandwich review on full diff + briefs + proceed artifacts; blockers/majors resolved in fix pass. Optional `/delegate-review` when adversarial second opinion is explicitly needed.
4. **Public surfaces match the source RFC.** Diffs to the RFC's §4 interface spec require an explicit RFC amendment in the same sprint.
5. Telemetry / observability events match the engine's documented packet taxonomy (`packages/core/src/packets.ts`). New events (e.g. an `iu_ledger` debug event) require an explicit doc amendment.
6. Docs updated: at minimum the touched package's README; at most an RFC delta.
7. Manual demo artifact captured per story or per sprint (test run output, trace, or live smoke log).
8. **No `--no-verify`, no type-suppression (`@ts-ignore`/`as any` packet bypass), no silent-catch shortcuts.** If you can't meet a check, change the design, not the gate.

### 1.3 Branching and commits
- **Build branch:** `plan/iu-substrate` (canonical name in `sprints/STATE.md` § Build branch). All Phase A story commits and Phase B fix/closeout commits land on this branch. **Do not commit to `main` during a sprint session.** Merge to `main` happens via PR after the sprint (or the whole Phase 0) ships.
- IC (`grok`) commits per-story atomic implementations on the build branch. Manager commits the fix pass + closeout commits on the same branch.
- Every commit message includes the story id (or `[S{N}-fix]` / `[S{N}-close]` for manager commits) and a body summarizing the diff. End commit messages with the repo's `Co-Authored-By` trailer.
- Demo artifact links live in the commit body.

### 1.4 The review loop (proceed evidence in Phase A; manager review in Phase B)

**Phase A — IC + proceed evidence (no review workers):**

1. **IC implementation.** `grok` fired fresh per story via `/delegate --mode impl`. Proof JSON, atomic commit. One worker = one story = one context window.
2. **Code map (when needed).** Before briefing, manager runs **`/code-understand`** for unfamiliar surfaces; links `.understanding/<slug>.md` in brief **Read These First**.
3. **Proceed evidence (manager).** After each story: read the diff (hunks, not the worker transcript) + re-run the claimed proof commands (`verify-handoff-proof.sh` or the raw `pnpm` commands) → `proceed-S{N}-{nn}.md`. **`PROCEED`** → next story. **`HOLD`** → re-delegate IC only.
4. Repeat until every story has **`PROCEED`**.

**Phase B — manager review (only after Phase A complete):**

5. **Manager sandwich review.** Full sprint diff + every brief + every proceed file → `review-sprint.md` (`REVIEW-r1.md` shape).
6. **Manager fix pass.** Commit `[S{N}-fix] {description}`. Optional `/delegate-review` — not default.
7. Sprint closes when WARMDOWN + HANDOFF + STATE-update commit lands.

> **Live smokes are manager-run** (per the `manager-runs-smokes` project rule): the IC develops and writes unit tests; the manager runs any live/provider smoke (`smoke:telnyx-emulator`, etc.) during proceed evidence or Phase B. Latency-sensitive smokes use the short fixture (`SYRINX_WS_MAX_TURNS=1`) per `latency-gate-short-fixtures`.

### 1.5 Sprint warm-down (handoff to the next session)
Last hour of every sprint. Two artifacts:

1. `sprints/sprint-N/WARMDOWN.md` — what shipped, what's working, what's not, open issues, decisions made, RFC amendments this sprint.
2. `sprints/sprint-N/HANDOFF.md` — a one-page primer for the next session: read-me-first, current state of the world, sprint N+1 starting state.

The next session reads HANDOFF first, WARMDOWN if it needs depth.

---

## 2. The roadmap

| Sprint | Phase | Goal (one sentence) |
|--------|-------|---------------------|
| 0 | Ledger core (C1) ✅ | `IncrementalUnit` + `InMemoryIuLedger` exist in `packages/core`, dormant, with a monotonic/idempotent state machine proven by unit tests and green CI. **SHIPPED.** |
| 1 | Speculative on the ledger (C2) + first-class turn-identity producer | Speculative generation is re-expressed as an `IuLedger` consumer with **no behavior change** (aisdk speculative tests pass unchanged; `SpeculativeHold` private state gone), and the ledger gains its first producer — a `user_turn` IU keyed by `IncrementalUnitId {contextId, iuId, epoch}` with `epoch` promoted from the existing per-turn counter. |
| 2 | Heard-prefix commit boundary (C3) | On barge-in, history truncates to the heard prefix through `IuLedger.commit(prefix=heard)` — the specified-but-unwired guarantee, now wired and tested. |
| 3 | Migrate + delete dual bookkeeping (C4) | The deepgram/tts poison/cancelled/finalized sets are replaced by the ledger and deleted (zero-tech-debt), with the P0-cluster smoke still green (already passing pre-reshape). |
| 4 | Closeout (+ deferred B-05/B-06 only if consumer-forced) | Phase 0 documented for merge; the deferred `contextId`-split / structural-re-arm items land only if a consumer forces them this phase. |

The phases above map to the source RFC (as amended) as follows:

- **Sprint 0 → RFC §8 C1** (`incremental-unit.ts`, `iu-ledger.ts`; REQ-1,2,3,6) and §4.1/§4.2/§7. **Shipped.**
- **Sprint 1 → RFC §8 C2 + rescoped-C5** (`packages/aisdk/src/index.ts`; REQ-5) and §2.2/§6 — the speculative path re-expressed on the ledger, which is also where the ledger gets its first producer + first-class turn identity (see [amendment](../docs/rfc-incremental-unit-substrate-amendment-C5.md) §4).
- **Sprint 2 → RFC §8 C3** (`voice-agent-session.ts`, `tts-playout-clock.ts`; REQ-4) and §4.3/§6 (the `interrupt.tts` → commit-heard-then-revoke mapping).
- **Sprint 3 → RFC §8 C4** (`packages/deepgram/src/stt.ts`, `tts-core/src/engine.ts`; REQ-3,5) and §5.1 (deleted-after-parity). Note: the P0-cluster proof (§9.3) already passes pre-reshape; C4 is a zero-tech-debt consolidation, not a bug fix.
- **Sprint 4 → closeout**; the standalone `contextId`→session-id epoch split (old C5) is **backlog B-05**, the structural turn-boundary re-arm is **B-06** — both consumer-gated (amendment §3).

---

## 3. Sprint detail

The format below repeats per sprint. Stories use the id pattern `S{N}-{nn}` (e.g. `S0-01`).

### Sprint 0 — Ledger core (C1)

**Goal:** `IncrementalUnit` + `InMemoryIuLedger` exist in `packages/core`, dormant (no consumer wired yet), with a monotonic/idempotent state machine proven by unit tests and green CI.

| Story | Description | DoD |
|-------|-------------|------|
| S0-01 | Add `packages/core/src/incremental-unit.ts`: `IuState`, `IncrementalUnitId {contextId, iuId, epoch}`, `IncrementalUnit {id, kind, state, committedPrefix?}` types exactly per RFC §4.1. Export from `packages/core/src/index.ts`. | Types compile; exported and importable from `@kuralle-syrinx/core`; no runtime behavior. |
| S0-02 | Add `packages/core/src/iu-ledger.ts`: `IuLedger` interface (§4.2) + `InMemoryIuLedger` (§7) with `add/commit/revoke/get/latest/clear`. Synchronous, in-memory, per-`contextId`; terminal ops idempotent (no-op + debug event); commit/revoke of unknown `iuId` fails open. | `iu-ledger.test.ts` proves: monotonic transitions (`hypothesized → committed`/`revoked`, no un-commit); idempotent terminal ops; per-ctx isolation; `clear` only wipes one ctx; unknown-id → no-op. Happy + failure path each. |
| S0-03 | O(1) micro-bench + `packages/core/README` section documenting the ledger vocabulary and that it is dormant (no consumer until C2+). | Bench asserts add/commit/revoke are O(1) (constant vs ctx count); README paragraph added; `pnpm -r typecheck && pnpm -r test` green. |

**Demo:** captured `pnpm --filter @kuralle-syrinx/core test` output showing `iu-ledger.test.ts` green (state-machine + idempotency + isolation), plus the O(1) bench line.

**Dependencies:** none (Sprint 0). Requires creating the `plan/iu-substrate` build branch off `main` and confirming CI green on it.

**Source RFC §:** §8 C1; §4.1, §4.2, §7; REQ-1, REQ-2, REQ-3, REQ-6.

**Sprint-specific risks:**
- Over-abstraction (building machinery no consumer needs) → detection: nothing outside the two new files changes → mitigation: ledger ships dormant; consumers arrive in later sprints only.

**Exit criteria:** all stories Done; WARMDOWN written; HANDOFF prepared.

---

### Sprint 1 — Speculative on the ledger (C2) + first-class turn-identity producer

> Rescoped per [`docs/rfc-incremental-unit-substrate-amendment-C5.md`](../docs/rfc-incremental-unit-substrate-amendment-C5.md). Folds C2 with C5's genuine value (the ledger's first producer + first-class turn identity), delivered by C2 as the first real consumer. The standalone 15-file epoch reshape (old C5) is deferred to backlog B-05.

**Goal:** speculative generation is re-expressed as an `IuLedger` consumer with **no behavior change** (aisdk speculative tests pass unchanged; `SpeculativeHold` private state gone), and the ledger gains its first producer — a `user_turn` IU keyed by `IncrementalUnitId {contextId, iuId, epoch}` with `epoch` promoted from the existing per-turn counter.

| Story | Description | DoD |
|-------|-------------|------|
| S1-01 | Re-express the speculative path in `packages/aisdk/src/index.ts` on `IuLedger`: `eos.interim` → `ledger.add(user_turn hypothesized)`; `eos.turn_complete` (draft matches) → `commit` + promote; mismatch → `revoke` + regenerate; `eos.retracted` → `revoke` + discard. Construct `IncrementalUnitId` as `{contextId, iuId: contextId, epoch}` (`epoch` = the monotonic per-turn counter promoted to a field, or 0 where a transport has none). Wire the `onEvent` anomaly hook (S0 D-1) to push an `iu_ledger` debug/`llm.error` packet — its first real use. Remove `SpeculativeHold` private buffered state. | `speculative-on-ledger.test.ts`: promote == commit, discard == revoke, IU ids stamped with epoch; the existing aisdk speculative characterization tests pass **unchanged**; `SpeculativeHold` private set deleted (no dual bookkeeping). |

**Demo:** the existing aisdk speculative test suite green with zero edits to its assertions, plus a diff showing `SpeculativeHold`'s private state removed and the ledger receiving `add`/`commit`/`revoke`.

**Dependencies:** Sprint 0 (ledger). No dependency on a standalone epoch reshape — `contextId` stays per-turn; leaf plugins untouched.

**Source RFC §:** §8 C2 + amendment §4; §2.2, §6, §7; REQ-5. Abort criterion §11: if a characterization test flips and cannot be made equivalent, stop and keep the private set — treat the divergence as a real bug to triage.

**Sprint-specific risks:**
- Behavior divergence on re-expression → detection: the unchanged characterization suite flips → mitigation: RFC §11 abort — revert to the private set, triage the divergence before retrying.
- Latency regression from the ledger on the hot path → detection: aisdk speculative timing tests / `turn_latency` → mitigation: REQ-6 (ledger is O(1), synchronous, in-memory).

**Exit criteria:** all stories Done; WARMDOWN written; HANDOFF prepared.

---

### Sprint 2 — Heard-prefix commit boundary (C3)

**Goal:** on barge-in, history truncates to the heard prefix through `IuLedger.commit(prefix = heard)` — the guarantee the understanding artifact found specified-but-unwired, now wired for all transports and tested.

| Story | Description | DoD |
|-------|-------------|------|
| S2-01 | Wire `interrupt.tts` in `packages/core/src/voice-agent-session.ts` to `commit(latest assistant IU, prefix = heard)` then revoke the remainder, using `TtsPlayoutClock` + word timestamps when present, `spokenByContext` fallback otherwise (`tts-playout-clock.ts`). | `heard-prefix-commit.test.ts`: on interrupt, committed span == heard span (word-boundary when timestamps present; ms fallback otherwise); remainder revoked; existing barge-in characterization tests green. |

**Demo:** `heard-prefix-commit.test.ts` green showing committed==heard for both the word-timestamp and ms-fallback paths; a trace of an interrupted turn truncating history to the heard prefix.

**Dependencies:** Sprint 0 (ledger), Sprint 1 (the ledger producer + revoke semantics proven on the speculative path).

**Source RFC §:** §8 C3; §4.3, §6; REQ-4. Symptom-patch stop (§11): if it works only by special-casing one transport rather than through the ledger, stop — one commit boundary for all transports.

**Sprint-specific risks:**
- Symptom-patch (heard-prefix works for one transport only) → detection: run the test across both the timestamp and fallback paths → mitigation: RFC §11 hard-stop; re-derive at the ledger.

**Exit criteria:** all stories Done; WARMDOWN written; HANDOFF prepared.

---

### Sprint 3 — Migrate + delete dual bookkeeping (C4)

**Goal:** the deepgram/tts poison/cancelled/finalized sets are replaced by the ledger and deleted (zero-tech-debt), with the telephony multi-turn smoke still green (it already passes pre-reshape — this is consolidation, not a bug fix).

| Story | Description | DoD |
|-------|-------------|------|
| S3-01 | Migrate `packages/deepgram/src/stt.ts` finalized-context drop and `packages/tts-core/src/engine.ts` cancel bookkeeping to `IuLedger` commit/revoke; **delete** the old poison/cancelled/finalized sets (`boundedAdd`/`MAX_RETIRED_CONTEXTS`/`MAX_CANCELLED_CONTEXTS`/`clearCancelledIfDrained`) — no dual bookkeeping kept. | Deepgram/tts unit tests green against the ledger; old private sets removed in the diff; `pnpm -r typecheck && pnpm -r test` green (pre-existing playwright-core failure excepted). |
| S3-02 | Regression: manager runs `smoke:telnyx-emulator` (short fixture) and confirms Node telephony still reaches turn 2+ after the migration; browser transports unchanged. | Live smoke log shows turn 2+ (parity with pre-reshape); no browser regression. |

**Demo:** a diff summary showing the deleted private sets and the single `IuLedger` they were replaced by, plus the `smoke:telnyx-emulator` log at turn 2+ (parity).

**Dependencies:** Sprints 0–2 (ledger + speculative-on-ledger + heard-prefix all landed).

**Source RFC §:** §8 C4; §5.1 (deleted-after-parity), §9.3 (smoke); REQ-3, REQ-5. Note: §9.3's "P0 cluster resolved" is already true pre-reshape (amendment §1) — this smoke is a **regression guard**, not the fix.

**Sprint-specific risks:**
- Deleting a private set that still had a live reader → detection: workspace typecheck + package tests → mitigation: migrate-then-delete within the same story; independently revertible.
- The bounded sets have subtle eviction semantics (`clearCancelledIfDrained`) the ledger must preserve → detection: deepgram/tts characterization tests → mitigation: port the eviction behavior onto `clear`/`revoke`; keep the private set if a test flips (RFC §11).

**Exit criteria:** all stories Done; WARMDOWN written; HANDOFF prepared.

---

### Sprint 4 — Closeout (+ deferred B-05/B-06 only if consumer-forced)

**Goal:** Phase 0 is documented and ready to merge to `main`; the deferred `contextId`-split (B-05) and structural re-arm (B-06) land only if a consumer forces them this phase.

| Story | Description | DoD |
|-------|-------------|------|
| S4-01 | Closeout: update `packages/core`/`deepgram`/`tts-core` READMEs to reflect the ledger as the single turn-bookkeeping primitive; fold the C5 amendment's conclusions into the RFC (or link it); prepare the Phase 0 → `main` PR description. | READMEs reflect the ledger; RFC ↔ amendment reconciled; PR description drafted; `pnpm -r typecheck && pnpm -r test` green. |
| S4-02 | (Conditional) If Sprints 1–3 surfaced a real need for epoch **ordering** or a stable-session `contextId`, scope B-05/B-06 here; otherwise confirm they stay backlog with a one-line rationale. | Either B-05/B-06 scoped as a follow-up task with a consumer citation, or an explicit "no consumer — stays backlog" note in WARMDOWN. |

**Demo:** the Phase 0 PR description + a green `pnpm -r typecheck && pnpm -r test`.

**Dependencies:** Sprints 0–3.

**Source RFC §:** §10, §11; amendment §3 (deferred items).

**Sprint-specific risks:**
- Scope creep back into the deferred 15-file reshape → detection: any B-05 work without a named consumer → mitigation: B-05 is consumer-gated; a no-consumer note closes it.

**Exit criteria:** Phase 0 PR description ready; board reconciled; STATE marks Phase 0 complete.

---

## 4. Backlog (deferred to v1.x or v2)

| ID | Item | Earliest | Source RFC § |
|----|------|----------|--------------|
| B-01 | Fine-grained sub-word IU revision network (the full IU cascade, per Schlangen & Skantze 2011) | After the InteractionPolicy eval harness settles degenerate-vs-fine-grained | §1.1 Non-Goals; §2.3; §12 Q1 |
| B-02 | Incremental / revisable TTS output (INPRO_iSS-style mid-utterance revision) | After the commit/revoke lattice exists | §1.1 Deferred |
| B-03 | Persist committed IUs to the durable store (G4) | v1.x (durable reasoner store already persists committed history) | §12 Q3 |
| B-04 | Fold ledger ownership into `VoiceAgentSession` vs standalone | Not planned — RFC §12 Q2 chose standalone | §12 Q2 |
| B-05 | Standalone `contextId` → stable-session-id + per-turn `epoch` split (the full old-C5 15-file reshape) | Consumer-gated: when something needs epoch **ordering** or a stable-session `contextId` (none does today) | amendment §3; RFC §8 C5 |
| B-06 | Structural turn-boundary re-arm (replace the comment-driven per-turn Set clearing at `voice-agent-session.ts:828-836`) | When the next per-turn Set is added and the manual re-arm becomes a hazard | amendment §3 |

---

## 5. Risks tracked across sprints

| Risk | Sprint(s) it materializes | Owner | Mitigation |
|------|---------------------------|-------|------------|
| Over-abstraction — IU machinery no consumer needs | S0 | Manager | Ship the ledger dormant; only re-express existing features (REQ-5); degenerate turn/segment granularity until measured (§12 Q1). **Also drove the C5 rescope** (amendment): don't build the epoch reshape no consumer reads. |
| Behavior divergence on re-expression (a characterization test flips) | S1, S2, S3 | IC + Manager | RFC §11 abort: keep the private set, treat divergence as a real bug to triage first — do not force equivalence. |
| Symptom-patch on the heard-prefix commit (works for one transport only) | S2 | Manager | RFC §11 hard-stop: one commit boundary for all transports; re-derive at the ledger. |
| Deleting a private set with a live reader | S3 | IC | Migrate-then-delete in one story; workspace typecheck + package tests gate the delete. |
| Latency regression from ledger on the hot path | S1, S2, S3 | Manager | REQ-6: ledger is in-memory, synchronous, O(1); `turn_latency` no-regression vs the pre-reshape baseline (short-fixture smoke). |
| Scope creep back into the deferred 15-file epoch reshape | S1, S4 | Manager | B-05 is consumer-gated; `contextId` stays per-turn; leaf plugins untouched until a consumer forces the split. |

---

## 6. The role of this document

This WBS is the *plan*, not the *prompt*. The program driver lives at [`./SESSION_KICKOFF_PROMPT.md`](./SESSION_KICKOFF_PROMPT.md). The current sprint pointer lives at [`./STATE.md`](./STATE.md). Templates live under [`./templates/`](./templates/).

When this WBS conflicts with the source RFC (`docs/rfc-incremental-unit-substrate.md`), **the RFC wins** — amend this document in the same PR.
