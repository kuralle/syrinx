# Sprint 1 — Manager review (Phase B)

**Reviewer:** Opus 4.8 (1M) manager, 2026-07-09
**Scope:** `5768440` `[S1-01]` + `3d6770a` `[S1-01] fix` on `plan/iu-substrate`
**Story:** S1-01 (C2 + identity producer). Proceed evidence: HOLD → fix → PROCEED.

## Praise

- Faithful to the hard design call (D-4): `SpeculativeHold`'s commit *state* moved to the ledger, its side-effect *buffer* kept — the only behavior-preserving reading. `promoted`/`failed` booleans are gone; no dual bookkeeping.
- The ledger got its first real producer + first-class turn identity (epoch), and the S0 `onEvent` hook its first real use (recoverable `iu_ledger` `llm.error`). This is the C5 value, delivered by a real consumer exactly as the amendment intended.
- Tests are behavioral: the 4 existing speculative tests pass unchanged; the 4 new ledger tests assert state transitions + the anomaly-on-bus + monotonic epoch.

## Findings

| # | Severity | Area | Finding | Resolution |
|---|----------|------|---------|------------|
| 1 | **major** | `index.ts` buffering gate | Round-1 hoisted the per-push commit-state check into one const → post-promotion streaming tail (incl. `llm.done`) lost. Existing tests missed it. | **Fixed** in `3d6770a` (per-call `isBuffering()`). Locked by manager-authored regression guard `speculative-post-promotion.test.ts` (fails pre-fix, passes post-fix). |
| 2 | minor | `speculative-on-ledger.test.ts` | Uses `as unknown as BridgeLedgerAccess` to read private `iuLedger`/`speculativeDraft`. | Accept — test-only private introspection, not a production `as any`. Reasonable way to assert ledger state. |
| 3 | minor | `packets.ts` | `component` union widened with `"iu_ledger"` on `VoiceErrorPacket` + `LlmErrorPacket`. | Accept — minimal, necessary for the tagged `llm.error`; additive (no exhaustive-switch consumer broke; workspace typecheck green). |

No blockers remain. No `--no-verify` / `@ts-ignore` / `as any` in production code / silent-catch.

## Regression

- `pnpm --filter @kuralle-syrinx/aisdk test` — 4 files, 37 tests green (incl. regression guard).
- `pnpm -r typecheck` — no new failure vs baseline (only known `examples/02`). The `packets.ts` union widening broke nothing.

## Verdict

**Sprint 1 accepted.** The HOLD→fix loop did its job — the manager pass caught a real regression green tests missed, and the fix is now locked by a permanent guard. Proceed to warm-down and advance to Sprint 2 (heard-prefix commit, C3).
