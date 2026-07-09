# Project State

> **Single source of truth for "where are we right now."** Updated at the end of every sprint warm-down.

---

## Active sprint

**Sprint number:** `4`
**Sprint name:** Closeout — Phase 0 PR to main
**Status:** `PR-ready — awaiting user go to push to kuralle + open the PR (outward-facing)`
**Goal:** Phase 0 documented and PR-ready to `main`; present the honest PR description; do NOT push/open the PR without user confirmation (outward-facing; git remote is `kuralle`).
**WBS section:** [`sprints/WBS.md` § Sprint 4](./WBS.md)
**Phase 0 substrate work is COMPLETE** (C1/C2/C3 shipped + leak fix). Deferred with rationale: C5→B-05, C4 migration→B-07, structural re-arm→B-06 (all in the C5 amendment).

## Build branch

**Active build branch:** `plan/iu-substrate`

Every sprint session — manager and IC — works **on this branch only**. Before Step 1 of the kickoff, confirm `git branch --show-current` matches. All story commits (`[S{N}-{nn}]`), fix-pass (`[S{N}-fix]`), and closeout (`[S{N}-close]`) land here. Do **not** commit to `main` mid-sprint — this repo's default is `main` and Phase 0 merges to it via PR after the work ships.

At session start: `git checkout plan/iu-substrate` (or `git checkout -b plan/iu-substrate` the first time, branched off `main`).

## Load-bearing reading for sprint 3 (rescoped — leak fix)

The session running sprint 3 must read these in this order before delegating any story:

1. `sprints/WBS.md` § Sprint 3 (bound the ledger + skip the migration) — the plan.
2. `runs/iu-substrate-implementation-notes.md` D-6 — why the migration is skipped + the leak.
3. `packages/core/src/iu-ledger.ts` — `InMemoryIuLedger` (`byCtx` Map, `clear`); add the bound here.
4. `packages/deepgram/src/stt.ts:52-61` — `boundedAdd`/`MAX_RETIRED_CONTEXTS=256` — the eviction pattern to mirror.
5. `packages/aisdk/src/index.ts` — `iuLedger` usage; `clearTurnState` (the turn-cleanup point to wire `clear`) + `close()` (clear-all).

## Last completed sprint

`3 — Bound the ledger + skip the migration (C4, rescoped)`

## Last completed at

`2026-07-09`

## Sprint history

| Sprint | Status | Completed at | Warmdown |
|--------|--------|--------------|----------|
| 0 | done | 2026-07-09 | [sprint-0/WARMDOWN.md](./sprint-0/WARMDOWN.md) |
| 1 | done | 2026-07-09 | [sprint-1/WARMDOWN.md](./sprint-1/WARMDOWN.md) |
| 2 | done | 2026-07-09 | [sprint-2/WARMDOWN.md](./sprint-2/WARMDOWN.md) |
| 3 | done | 2026-07-09 | [sprint-3/WARMDOWN.md](./sprint-3/WARMDOWN.md) |
| 4 | PR-ready | 2026-07-09 | closeout — [PHASE-0-PR-DESCRIPTION.md](./PHASE-0-PR-DESCRIPTION.md) |
| 2 | not-started | — | — |
| 3 | not-started | — | — |
| 4 | not-started | — | — |

When a sprint completes, append/update its row here from `WARMDOWN.md`.

## Backlog deltas this project life

`(none)`

## Open RFC amendments

`(none)`

---

## How to use this file

- A new session reads this file **first** to know which sprint is active and which sections of which docs are load-bearing right now.
- The session running a sprint **does not edit this file mid-sprint**. Updates land at warm-down.
- At warm-down, the session updates: active sprint pointer, **build branch** (only if it changed), load-bearing reading for the next sprint, last-completed fields, sprint history table, backlog deltas, and any open RFC amendments.
- **Plan Desk mirror:** this is Phase 0 of the bound Plan Desk project "Syrinx vNext" (task *Build IU substrate (IuLedger + turn-epoch)*). Keep the board task status in sync with this file — `in_progress` while sprints run, `done` when Sprint 4 closes and the Phase 0 PR is ready.
