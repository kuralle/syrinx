# Work Breakdown Structure — IU Substrate (Syrinx vNext, Phase 0)

> **The build plan, sprint by sprint, end-to-end.** Spans `docs/rfc-incremental-unit-substrate.md` (the capstone/substrate RFC that reframes speculative generation, eager-EOT, barge-in truncation, and the `contextId → turn-epoch` reshape as one commit/revoke primitive) with academic grounding in `research/incremental-processing-deep-dive.md`. Every sprint is an end-to-end demoable slice, not a horizontal slab. Cadence and engineering practice are the same across all sprints.

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
| 0 | Ledger core (C1) | `IncrementalUnit` + `InMemoryIuLedger` exist in `packages/core`, dormant, with a monotonic/idempotent state machine proven by unit tests and green CI. |
| 1 | Turn-epoch identity (C5) | `IncrementalUnitId {contextId, iuId, epoch}` supersedes the `contextId = turn id` overload in packets and consumers, with browser-per-turn and telephony-per-call both correct. |
| 2 | Speculative on the ledger (C2) | Speculative generation is re-expressed as an `IuLedger` consumer with **no behavior change** — the existing aisdk speculative tests pass unchanged and `SpeculativeHold`'s private state is gone. |
| 3 | Heard-prefix commit boundary (C3) | On barge-in, history truncates to the heard prefix through `IuLedger.commit(prefix=heard)` — the specified-but-unwired guarantee, now wired and tested. |
| 4 | Migrate + delete dual bookkeeping (C4) + closeout | The deepgram/tts poison/cancelled/finalized sets are replaced by the ledger and deleted, multi-turn Node telephony reaches turn 2+ (the P0 cluster is resolved), and Phase 0 is documented for merge. |

The phases above map to the source RFC as follows:

- **Sprint 0 → RFC §8 C1** (`incremental-unit.ts`, `iu-ledger.ts`; REQ-1,2,3,6) and §4.1/§4.2/§7 (interface + blueprint).
- **Sprint 1 → RFC §8 C5** (`packets.ts` + consumers; REQ-1) and §2/§5.1 (the `contextId` overload this reshapes). Front-loaded per §12 Q4 because both downstream RFCs' C1 depend on turn identity.
- **Sprint 2 → RFC §8 C2** (`packages/aisdk/src/index.ts`; REQ-5) and §2.2/§6 (the speculative path re-expression).
- **Sprint 3 → RFC §8 C3** (`voice-agent-session.ts`, `tts-playout-clock.ts`; REQ-4) and §4.3/§6 (the `interrupt.tts` → commit-heard-then-revoke mapping).
- **Sprint 4 → RFC §8 C4** (`packages/deepgram/src/stt.ts`, `tts-core/src/engine.ts`; REQ-3,5) and §5.1 (deleted-after-parity), plus §9.3 the P0-cluster proof and §10/§11 closeout.

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

### Sprint 1 — Turn-epoch identity (C5)

**Goal:** `IncrementalUnitId {contextId, iuId, epoch}` supersedes the `contextId = turn id` overload in the packet layer and its consumers, with browser-per-turn and telephony-per-call turn boundaries both correct.

| Story | Description | DoD |
|-------|-------------|------|
| S1-01 | Introduce IU identity (`iuId` + monotonic `epoch`) into the turn-scoped packets in `packages/core/src/packets.ts`; `contextId` stays the transport/session id. Mint epoch at turn start. | Packet types carry IU id; `contextId` semantics unchanged for transport; typecheck green across workspace. |
| S1-02 | Thread the id through the turn-boundary consumers so browser mints a new epoch per turn and telephony (one `contextId` per call) advances the epoch per turn instead of reusing turn id. | Turn-boundary characterization tests green; a new test proves browser-per-turn and telephony-per-call both produce distinct, monotonic epochs. |

**Demo:** test-run artifact showing turn-boundary tests green with the new epoch, plus a short trace of a two-turn telephony `contextId` keeping identity while epoch increments.

**Dependencies:** Sprint 0 (the `IncrementalUnitId` type).

**Source RFC §:** §8 C5; §2 (current-state overload), §5.1; REQ-1. Front-loaded per §12 Q4.

**Sprint-specific risks:**
- Reshape blast radius across turn-boundary code → detection: workspace typecheck + characterization suite → mitigation: identity-only change this sprint (no ledger wiring yet); independently revertible.

**Exit criteria:** all stories Done; WARMDOWN written; HANDOFF prepared.

---

### Sprint 2 — Speculative on the ledger (C2)

**Goal:** speculative generation is re-expressed as an `IuLedger` consumer with **no behavior change** — the existing aisdk speculative tests pass unchanged and `SpeculativeHold`'s private buffered state is removed in favor of the ledger.

| Story | Description | DoD |
|-------|-------------|------|
| S2-01 | Re-express the speculative path in `packages/aisdk/src/index.ts` on `IuLedger`: `eos.interim` → `ledger.add(user_turn hypothesized)`; `eos.turn_complete` (draft matches) → `commit` + promote; mismatch → `revoke` + regenerate; `eos.retracted` → `revoke` + discard. Remove `SpeculativeHold` private state. | `speculative-on-ledger.test.ts`: promote == commit, discard == revoke; the existing aisdk speculative characterization tests pass **unchanged**; `SpeculativeHold` private set deleted (no dual bookkeeping). |

**Demo:** the existing aisdk speculative test suite green with zero edits to its assertions, plus a diff showing `SpeculativeHold`'s private state removed.

**Dependencies:** Sprint 0 (ledger), Sprint 1 (turn identity).

**Source RFC §:** §8 C2; §2.2, §6, §7; REQ-5. Abort criterion §11: if a characterization test flips and cannot be made equivalent, stop and keep the private set — treat the divergence as a real bug to triage.

**Sprint-specific risks:**
- Behavior divergence on re-expression → detection: the unchanged characterization suite flips → mitigation: RFC §11 abort — revert to the private set, triage the divergence before retrying.

**Exit criteria:** all stories Done; WARMDOWN written; HANDOFF prepared.

---

### Sprint 3 — Heard-prefix commit boundary (C3)

**Goal:** on barge-in, history truncates to the heard prefix through `IuLedger.commit(prefix = heard)` — the guarantee the understanding artifact found specified-but-unwired, now wired for all transports and tested.

| Story | Description | DoD |
|-------|-------------|------|
| S3-01 | Wire `interrupt.tts` in `packages/core/src/voice-agent-session.ts` to `commit(latest assistant IU, prefix = heard)` then revoke the remainder, using `TtsPlayoutClock` + word timestamps when present, `spokenByContext` fallback otherwise (`tts-playout-clock.ts`). | `heard-prefix-commit.test.ts`: on interrupt, committed span == heard span (word-boundary when timestamps present; ms fallback otherwise); remainder revoked; existing barge-in characterization tests green. |

**Demo:** `heard-prefix-commit.test.ts` green showing committed==heard for both the word-timestamp and ms-fallback paths; a trace of an interrupted turn truncating history to the heard prefix.

**Dependencies:** Sprint 0 (ledger), Sprint 1 (turn identity), Sprint 2 (revoke semantics proven on the speculative path).

**Source RFC §:** §8 C3; §4.3, §6; REQ-4. Symptom-patch stop (§11): if it works only by special-casing one transport rather than through the ledger, stop — one commit boundary for all transports.

**Sprint-specific risks:**
- Symptom-patch (heard-prefix works for one transport only) → detection: run the test across both the timestamp and fallback paths → mitigation: RFC §11 hard-stop; re-derive at the ledger.

**Exit criteria:** all stories Done; WARMDOWN written; HANDOFF prepared.

---

### Sprint 4 — Migrate + delete dual bookkeeping (C4) + closeout

**Goal:** the deepgram/tts poison/cancelled/finalized sets are replaced by the ledger and deleted, multi-turn Node telephony reaches turn 2+ (the P0 cluster is resolved), and Phase 0 is documented and ready to merge to `main`.

| Story | Description | DoD |
|-------|-------------|------|
| S4-01 | Migrate `packages/deepgram/src/stt.ts` finalized-context drop and `packages/tts-core/src/engine.ts` cancel bookkeeping to `IuLedger` commit/revoke; **delete** the old poison/cancelled/finalized sets (zero-tech-debt, no dual bookkeeping kept). | Deepgram/tts unit tests green against the ledger; old private sets removed in the diff; `pnpm -r typecheck && pnpm -r test` green (pre-existing playwright-core failure excepted). |
| S4-02 | Prove the P0 cluster is resolved: manager runs `smoke:telnyx-emulator` and confirms Node telephony reaches turn 2+. Capture the log. | Live smoke log shows turn 2+ on Node telephony; no regression on browser transports. |
| S4-03 | Closeout: update `packages/core`/`deepgram`/`tts-core` READMEs for the ledger; record any RFC amendments; prepare the Phase 0 → `main` PR description. | READMEs reflect the ledger as the single bookkeeping primitive; RFC amendments (if any) noted in WARMDOWN; PR description drafted. |

**Demo:** the `smoke:telnyx-emulator` log reaching turn 2+, plus a diff summary showing the three deleted private sets and the single `IuLedger` they were replaced by.

**Dependencies:** Sprints 0–3 (ledger + identity + speculative + heard-prefix all landed).

**Source RFC §:** §8 C4; §5.1 (deleted-after-parity), §9.3 (P0 proof command), §10, §11; REQ-3, REQ-5.

**Sprint-specific risks:**
- No measurable win on LLM backends (turn-granularity IU == today's behavior with more ceremony) → detection: honest reading of the diff → mitigation: the win is collapsing five bookkeeping implementations into one tested primitive + wiring the heard-prefix guarantee; that stands regardless (RFC §Risks).
- Deleting a private set that still had a live reader → detection: workspace typecheck + package tests → mitigation: migrate-then-delete within the same story; independently revertible.

**Exit criteria:** all stories Done; WARMDOWN written; HANDOFF prepared; Phase 0 PR description ready.

---

## 4. Backlog (deferred to v1.x or v2)

| ID | Item | Earliest | Source RFC § |
|----|------|----------|--------------|
| B-01 | Fine-grained sub-word IU revision network (the full IU cascade, per Schlangen & Skantze 2011) | After the InteractionPolicy eval harness settles degenerate-vs-fine-grained | §1.1 Non-Goals; §2.3; §12 Q1 |
| B-02 | Incremental / revisable TTS output (INPRO_iSS-style mid-utterance revision) | After the commit/revoke lattice exists | §1.1 Deferred |
| B-03 | Persist committed IUs to the durable store (G4) | v1.x (durable reasoner store already persists committed history) | §12 Q3 |
| B-04 | Fold ledger ownership into `VoiceAgentSession` vs standalone | Not planned — RFC §12 Q2 chose standalone | §12 Q2 |

---

## 5. Risks tracked across sprints

| Risk | Sprint(s) it materializes | Owner | Mitigation |
|------|---------------------------|-------|------------|
| Over-abstraction — IU machinery no consumer needs | S0 | Manager | Ship the ledger dormant; only re-express existing features (REQ-5); degenerate turn/segment granularity until measured (§12 Q1). |
| Reshape blast radius — turn-boundary code across five packages | S1, S4 | Manager | Per-consumer migration (C2–C5 independently revertible); the P0 cluster forces this reshape anyway. |
| Behavior divergence on re-expression (a characterization test flips) | S2, S3 | IC + Manager | RFC §11 abort: keep the private set, treat divergence as a real bug to triage first — do not force equivalence. |
| Symptom-patch on the heard-prefix commit (works for one transport only) | S3 | Manager | RFC §11 hard-stop: one commit boundary for all transports; re-derive at the ledger. |
| No measurable latency win on batch LLM backends | S4 | Manager | Reframe honestly: the win is collapsing five bookkeeping impls into one + wiring the heard-prefix guarantee — not latency (§Risks). |
| Deleting a private set with a live reader | S4 | IC | Migrate-then-delete in one story; workspace typecheck + package tests gate the delete. |
| Latency regression from ledger on the hot path | S2, S3, S4 | Manager | REQ-6: ledger is in-memory, synchronous, O(1); `turn_latency` no-regression vs the pre-reshape baseline (short-fixture smoke). |

---

## 6. The role of this document

This WBS is the *plan*, not the *prompt*. The program driver lives at [`./SESSION_KICKOFF_PROMPT.md`](./SESSION_KICKOFF_PROMPT.md). The current sprint pointer lives at [`./STATE.md`](./STATE.md). Templates live under [`./templates/`](./templates/).

When this WBS conflicts with the source RFC (`docs/rfc-incremental-unit-substrate.md`), **the RFC wins** — amend this document in the same PR.
