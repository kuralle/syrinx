# Proceed evidence — `S0-01` IU ledger core

**Verdict:** **PROCEED**
**Manager:** Opus 4.8 (1M), 2026-07-09
**Commit:** `1d5fe7e` `[S0-01] IU ledger core` on `plan/iu-substrate`
**Worker:** grok (`grok-composer-2.5-fast`)

## What was verified (manager re-ran; exit codes authoritative)

| Check | Command | Result |
|-------|---------|--------|
| Core typecheck | `pnpm --filter @kuralle-syrinx/core typecheck` | exit 0 |
| Core tests | `pnpm --filter @kuralle-syrinx/core test` | exit 0 — **19 files, 225 tests passed** (incl. new `iu-ledger.test.ts`) |
| Workspace regression | `pnpm -r typecheck` | only the known pre-existing `examples/02` playwright-core failure; core purely-additive exports break nothing |

Not trusting the worker's proof JSON — re-ran the two commands directly. (Note: `verify-handoff-proof.sh` errored `KeyError: 'type'` — a schema mismatch in the verifier script, not the work; superseded by the manual re-run.)

## Diff read (hunks, not the transcript)

- `incremental-unit.ts` — `IuState`, `IncrementalUnitId`, `IncrementalUnit` **verbatim** per RFC §4.1. ✓
- `iu-ledger.ts` — `IuLedger` interface exact (§4.2); `InMemoryIuLedger` uses `Map<ctx, Map<iuId, IU>>`; monotonic transitions (only `hypothesized` → terminal); idempotent terminal ops → `onEvent({kind:"terminal_op"})` + return; fail-open on unknown ctx/iu → `onEvent({kind:"unknown_iu"})` + return, no throw; `latest` iterates insertion order for last-matching-kind (Map preserves order — correct); `clear` deletes one ctx. **No bus import** (D-1 honored). Clean under `noUncheckedIndexedAccess` — no `!`, no `as`, no `@ts-ignore`. ✓
- `iu-ledger.test.ts` — every public method with ≥1 happy + ≥1 failure path; monotonic + no-un-commit + fail-open + per-ctx isolation + `latest` + `committedPrefix` + O(1). ✓
- `index.ts` — exports `IuLedger`, `IuLedgerAnomaly`, `InMemoryIuLedger` (+ IU types). Purely additive. ✓
- `README.md` — one dormant-ledger paragraph. ✓

## Scope discipline

Files changed exactly match the brief (`incremental-unit.ts`, `iu-ledger.ts`, `iu-ledger.test.ts`, `index.ts`, `README.md` + the demo artifact). Nothing outside scope; no consumer wired (dormant, as required).

## Minor (for Phase B, non-blocking)

- The O(1) test includes a wall-clock `performance.now()` ratio (`tLarge < max(tSmall*20, 1)`). Wide 20× margin + a `max(…,1)` floor + structural correctness assertions alongside make it non-flaky in practice, but a purely structural assertion (lookup counter) would be strictly better. Track as a possible Phase B tidy; not a HOLD.

## Decision

All acceptance criteria met; behavior verified by manager re-run; scope clean; RFC §4.1/§4.2 surfaces matched. → **PROCEED** to Phase B (single-story sprint).
