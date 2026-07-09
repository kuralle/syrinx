# Sprint 0 — Warm-down

> **Author (main session):** Opus 4.8 (1M) manager, 2026-07-09.
> **Sprint window:** 2026-07-09 (single session).
> **Outcome:** Goal achieved — the IU ledger substrate exists, is dormant, and is verified.

---

## 1. Goal recap

**Sprint goal (from WBS):** `IncrementalUnit` + `InMemoryIuLedger` exist in `packages/core`, dormant, with a monotonic/idempotent state machine proven by unit tests and green CI.

**Did we hit it?** Yes. The two files (`incremental-unit.ts`, `iu-ledger.ts`) ship the RFC §4.1/§4.2 surface verbatim, with a 225-test-green core suite including the new `iu-ledger.test.ts`. No consumer is wired (dormant, as designed); consumers arrive in Sprints 2–4.

---

## 2. Stories shipped

| Story | Status | Commit | Demo | Notes |
|-------|--------|--------|------|-------|
| S0-01 | Done | `1d5fe7e` | [s0-01.txt](./artifacts/s0-01.txt) | IU ledger core. Consolidated WBS S0-01/02/03 into one atomic story (types+ledger+tests are one file-pair — PLAN §0). |

---

## 3. What's working

- `InMemoryIuLedger` with `add/commit/revoke/get/latest/clear`, monotonic `hypothesized → committed|revoked`, idempotent terminal ops, fail-open on unknown ids. Verified by manager re-run: 19 files / 225 tests green.
- Standalone + dependency-free — imports nothing; anomalies surface through the optional `onEvent` hook.
- Exported from `@kuralle-syrinx/core` (`IuLedger`, `IuLedgerAnomaly`, `InMemoryIuLedger`, IU types).

---

## 4. What's not working / known issues

| ID | Description | Severity | Owner | Tracking |
|----|-------------|----------|-------|----------|
| KI-0-01 | O(1) test leans partly on a wall-clock `performance.now()` ratio (wide 20× margin + structural assertions alongside). Non-flaky in practice; a structural-only version would need ledger instrumentation no consumer wants. | minor | accepted | review-sprint.md finding #1 |

---

## 5. Decisions made

- **Decision:** the pure ledger surfaces RFC §4.2 anomalies (idempotent-terminal-op, unknown-id) via an optional constructor `onEvent?(a: IuLedgerAnomaly)` hook (default no-op) rather than importing the bus. **Rationale:** keeps the ledger standalone/testable per RFC §12 Q2; a consumer wires the hook to an `iu_ledger` debug/`llm.error` packet in C2+. **Source:** `runs/iu-substrate-implementation-notes.md` D-1. **RFC amendment:** none (consistent with §4.2 "fail-open" + §12 Q2).
- **Decision:** WBS S0-01/02/03 briefed as one atomic IC story. **Rationale:** one cohesive file-pair, no independent-ship benefit. **Source:** `sprints/sprint-0/PLAN.md` §0. **RFC amendment:** none.

---

## 6. Wiki / RFC amendments this sprint

No amendments this sprint. Public surface matches RFC §4.1/§4.2 exactly.

---

## 7. Metrics

- **Test count:** core 225 (added this sprint: the `iu-ledger.test.ts` cases — ledger state machine, idempotency, isolation, latest, prefix, O(1)).
- **New source LOC:** `incremental-unit.ts` 19, `iu-ledger.ts` 102, test 242.
- **Latency:** N/A — ledger is dormant (nothing on the hot path uses it yet; REQ-6 no-regression is proven in Sprints 2–4 when wired).

---

## 8. Backlog updates

**Added:** none (RFC backlog B-01…B-04 already in WBS §4).

**Promoted:** none.

**Removed:** none.

---

## 9. Retrospective

### Keep
The brief pinned the exact §4 signatures + house-style references (`reasoner-session-store.ts`, `tts-playout-clock.test.ts`) and the manager `onEvent` decision up front — grok produced a clean, in-scope, first-pass-green diff with zero drift. Front-loading the design call (D-1) into the brief avoided a HOLD.

### Change
The `verify-handoff-proof.sh` gate errored on a proof-schema field mismatch (`KeyError: 'type'`). It didn't matter (manager re-runs commands directly), but the script and the emitted proof schema have drifted. Worth reconciling before it masks a real failure.

### Try next
For Sprint 1 (turn-epoch identity — a reshape touching `packets.ts` + consumers, wider blast radius than S0), run `/code-understand` on the turn-boundary path first so the brief cites exact `file:line` for where `contextId`-as-turn-id is minted and consumed.

---

## 10. Pointers for the next sprint

- Files to read first: `docs/rfc-incremental-unit-substrate.md` §8 C5 + §2 (the `contextId = turn id` overload) + §5.1; `.understanding/syrinx-voice-engine-understand.md` (the P0 turn-boundary cluster); `packages/core/src/packets.ts`.
- Traps: telephony reuses one `contextId` per call while browser mints per-turn — S1's epoch must advance per-turn in both without breaking transport identity. This is the crux of C5.
- The ledger from S0 is available (`InMemoryIuLedger`) but S1 is identity-only — do **not** wire the ledger into consumers yet (that's S2–S4).
- Open RFC amendments: none.

---

## 11. Closeout

- [x] Shipped story committed atomically on `plan/iu-substrate` (`1d5fe7e`).
- [x] Proceed evidence + sprint review written.
- [x] `sprints/sprint-0/HANDOFF.md` written.
- [x] `sprints/STATE.md` updated (active sprint → 1, load-bearing reading refreshed).
- [x] Demo artifact archived under `sprints/sprint-0/artifacts/s0-01.txt`.

Sprint 0 is closed.
