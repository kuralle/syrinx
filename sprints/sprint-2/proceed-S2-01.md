# Proceed evidence — `S2-01` Assistant-side IU producer + heard-prefix commit

**Verdict:** **PROCEED**
**Manager:** Opus 4.8 (1M), 2026-07-09
**Commit:** `afc77b4` `[S2-01]` on `plan/iu-substrate`
**Worker:** grok

## Verified (manager re-ran)

| Check | Result |
|-------|--------|
| `pnpm --filter @kuralle-syrinx/aisdk typecheck` | exit 0 |
| `pnpm --filter @kuralle-syrinx/aisdk test` | exit 0 — **5 files, 42 tests** (37 existing unchanged + 5 new heard-prefix) |
| Workspace typecheck | (see below — index.ts-only change, no cross-package surface) |

## Diff read (hunks)

- `assistantIuIdFor` — distinct iuId `${contextId}#assistant`, same per-turn epoch. No collision with S1's user-turn IU (`iuId === contextId`). ✓
- `add(assistant_response hypothesized)` at generation start (after `activeGeneration` set). ✓
- `rememberTurn` → `commit(assistantIu)` full (clean completion). ✓
- `commitInterruptedHistory` → `commit(assistantIu, { chars: spoken.length, ms: playedOutMs })` when hypothesized. ✓
- `clearTurnState` → `revoke(assistantIu)` if still hypothesized (aborted/superseded). ✓
- The existing `computeSpokenPrefix` + history rewrite are **untouched** — behavior-preserving, as required. ✓

## Test coverage (the S1 lesson applied)

The 5 new tests cover exactly the enumerated timing cases:
1. word-boundary prefix on barge-in — asserts `committedPrefix.chars === spoken.length`, `.ms === 450`, **and `chars < full-reply length`** (proves a genuine prefix, not the whole reply).
2. `spokenByContext` ms-fallback (no word timestamps).
3. **mid-stream interrupt without losing streamed packets** — the exact class of bug that HELD S1; the IC pre-empted it here (committed prefix `=== "Hello".length`, packets intact).
4. clean completion → `committedPrefix` undefined (fully heard).
5. distinct assistant + user-turn IUs coexist for one contextId.

I did not need to build my own mid-stream repro — test #3 already exercises it rigorously.

## Minor (non-blocking, for Phase B note)

- `commitInterruptedHistory` `else if (state === "committed") { assistantIu.committedPrefix = prefix }` mutates the IU's `committedPrefix` field directly (bypassing the ledger API) to handle a completed-then-interrupted turn. Benign: `committedPrefix` has no consumer yet (C4 reads it), and it refines the heard span rather than changing state. A ledger `refinePrefix` method would be cleaner but is not worth adding now. Track as a Phase B note.

## Decision

Behavior-preserving, well-tested (incl. the mid-stream case), scope-clean. → **PROCEED** to Phase B.
