# Proceed evidence — `S3-01` Bound InMemoryIuLedger (leak fix)

**Verdict:** **PROCEED**
**Manager:** Opus 4.8 (1M), 2026-07-09
**Commit:** `71f79f2` `[S3-01]` on `plan/iu-substrate`
**Worker:** grok

## Verified (manager re-ran)

| Check | Result |
|-------|--------|
| `pnpm --filter @kuralle-syrinx/core typecheck` | exit 0 |
| `pnpm --filter @kuralle-syrinx/core test` | exit 0 — **227 tests** (225 + 2 new bound tests) |
| `pnpm --filter @kuralle-syrinx/aisdk test` | exit 0 — **42 tests unchanged** |
| `pnpm -r typecheck` | only the known `examples/02` failure — no regression |

## Diff read

- Constructor: `maxContexts = 256` added as an optional second param — **backward-compatible** (`new InMemoryIuLedger(onEvent)` still compiles; verified aisdk unchanged).
- `add`: before inserting a **new** context at cap, evicts the oldest (`byCtx.keys().next().value`, FIFO — Map insertion order) — exactly mirrors `boundedAdd`/`MAX_RETIRED_CONTEXTS`. Adding an IU to an existing context does not evict.
- `commit`/`revoke`/`get`/`latest`/`clear` untouched.
- Correctly did **not** wire per-turn `clear` or add a `clearAll` (skipped per brief §2b — the bound is the complete fix).
- Scope clean: only `iu-ledger.ts` + its test + the artifact.

New tests: "evicts the oldest context when a new context exceeds the cap (FIFO)" + "does not evict when adding another IU to an existing context".

## Decision

The leak is fixed with the same proven bounded pattern the private sets use; behavior-preserving; scope-clean. → **PROCEED** to Phase B / closeout.
