# Sprint 0 — Manager review (Phase B)

**Reviewer:** Opus 4.8 (1M) manager, 2026-07-09
**Scope:** commit `1d5fe7e` `[S0-01] IU ledger core` on `plan/iu-substrate`
**Stories:** S0-01 (only). Proceed evidence: `proceed-S0-01.md` → PROCEED.

## Praise (what's right)

- Faithful to the contract: `incremental-unit.ts` and the `IuLedger` interface are verbatim RFC §4.1/§4.2. No signature drift.
- Correct core semantics: monotonic state machine, idempotent terminal ops, fail-open on unknown ids — the exact invariants REQ-2 demands.
- Zero coupling: the ledger imports nothing (`onEvent` hook is the seam per D-1), so it stays standalone and testable in isolation (§12 Q2). This is what keeps Sprints 2–4 able to wire it to the bus without a reshape.
- Test suite is behavioral, not shape-only: it asserts real transitions and anomaly payloads, each public method with happy + failure paths.

## Findings

| # | Severity | File:area | Finding | Action |
|---|----------|-----------|---------|--------|
| 1 | minor | `iu-ledger.test.ts` O(1) case | Uses a wall-clock `performance.now()` ratio (`tLarge < max(tSmall*20, 1)`) alongside structural correctness assertions. | **No fix.** A purely-structural version would require adding a lookup counter to the production ledger — instrumentation no consumer needs (violates §2 simplicity). The wide 20× margin + `max(…,1)` floor + the co-located structural assertions (`commit` touches only the target ctx at N=10 and N=1000) make it non-flaky. Accept as-is; documented here so it is not mistaken for oversight. |

No blockers, no majors. No `--no-verify` / `@ts-ignore` / `as any` / silent-catch anywhere in the diff.

## Regression

- `pnpm --filter @kuralle-syrinx/core test` — 19 files, 225 tests green (manager re-ran).
- `pnpm -r typecheck` — no new failure vs baseline (only the known pre-existing `examples/02` playwright-core).

## Verdict

**Sprint 0 accepted.** No fix pass required. The IU substrate exists, is dormant, is verified. Proceed to warm-down and advance to Sprint 1 (turn-epoch identity, RFC C5).
