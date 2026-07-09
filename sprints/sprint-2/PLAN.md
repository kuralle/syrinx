# Sprint 2 — Plan

**Sprint name:** Heard-prefix commit boundary (C3)
**Sprint goal:** the ledger gains an `assistant_response` IU per turn; barge-in commits it with `committedPrefix = heard` (from the existing `computeSpokenPrefix`), clean completion commits it fully — **behavior-preserving** (the existing `commitInterruptedHistory` history rewrite is untouched; the ledger record is added alongside).
**Author:** Opus 4.8 (1M) manager, 2026-07-09
**Premise correction:** see WBS § Sprint 2 (D-5) — heard-prefix truncation is already wired (v4.x G25); C3 re-expresses it on the ledger, it does not "wire an unwired guarantee".

## Story `S2-01` — assistant-side IU producer + heard-prefix commit

**Description:** Add an `assistant_response` IU to the ledger for each turn's assistant reply, with a **distinct** iuId (`${contextId}#assistant`) so it coexists with S1's `user_turn` IU (same `contextId`). Add it hypothesized at generation start; commit it fully on clean completion (`rememberTurn`); commit it with `committedPrefix = { chars: spoken.length, ms: playedOutMs }` on barge-in (`commitInterruptedHistory`); revoke it if the generation is discarded/aborted without committing (`clearTurnState`). The existing history-rewrite logic (which already truncates to the heard prefix) is **not changed** — C3 only adds the ledger record.

**Acceptance criteria:**
1. All existing aisdk tests (37) pass **unchanged** — barge-in/history/speculative behavior identical (RFC §11 abort if one flips).
2. New `heard-prefix-commit.test.ts`: on barge-in, the assistant IU is `committed` with `committedPrefix` matching the heard span — **both** the word-boundary path (word timestamps + `playedOutMs`) **and** the `spokenByContext` ms-fallback path. Include a **mid-stream interrupt** case (S1 lesson).
3. Clean completion commits the assistant IU fully (no truncated prefix); a discarded/aborted generation revokes it.
4. Assistant IU iuId is distinct from the user-turn IU iuId (no ledger-key collision); same `epoch`.
5. `pnpm --filter @kuralle-syrinx/aisdk typecheck && test` green; workspace typecheck no worse than baseline.

**Files:** `packages/aisdk/src/index.ts` (modify), `packages/aisdk/src/heard-prefix-commit.test.ts` (create).

**Demo:** `sprints/sprint-2/artifacts/s2-01.txt` — aisdk test run showing the new heard-prefix test + 37 existing green.

## Risks

| Risk | Detection | Mitigation |
|------|-----------|------------|
| Behavior change to the already-correct history truncation | existing barge-in/history tests flip | C3 only ADDS ledger calls; `commitInterruptedHistory`/`rememberTurn` rewrite untouched; §11 abort. |
| Assistant IU collides with user-turn IU (same contextId key) | ledger `get`/`latest` returns the wrong IU | distinct iuId `${contextId}#assistant`. |
| Missing the mid-stream interrupt timing case | — | explicit acceptance criterion (S1 lesson); manager builds a repro if the IC's test is thin. |

## Open questions
- **OQ-S2-1 (resolved):** "revoke the remainder" (RFC §6) in turn-granularity? → There is one assistant IU per turn; `commit(prefix=heard)` records the heard span, and the existing history truncation IS the "revoke the rest". No separate remainder IU (that's the fine-grained model, backlog B-01).
