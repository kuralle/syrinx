# Project State

> **Single source of truth for "where are we right now."** Updated at the end of every sprint warm-down.

---

## Active sprint

**Sprint number:** `0`
**Sprint name:** Ledger core (C1)
**Status:** `not-started`
**Goal:** `IncrementalUnit` + `InMemoryIuLedger` exist in `packages/core`, dormant, with a monotonic/idempotent state machine proven by unit tests and green CI.
**WBS section:** [`sprints/WBS.md` § Sprint 0](./WBS.md)

## Build branch

**Active build branch:** `plan/iu-substrate`

Every sprint session — manager and IC — works **on this branch only**. Before Step 1 of the kickoff, confirm `git branch --show-current` matches. All story commits (`[S{N}-{nn}]`), fix-pass (`[S{N}-fix]`), and closeout (`[S{N}-close]`) land here. Do **not** commit to `main` mid-sprint — this repo's default is `main` and Phase 0 merges to it via PR after the work ships.

At session start: `git checkout plan/iu-substrate` (or `git checkout -b plan/iu-substrate` the first time, branched off `main`).

## Load-bearing reading for sprint 0

The session running sprint 0 must read these in this order before delegating any story:

1. `sprints/WBS.md` — full read; this is the plan.
2. `sprints/SESSION_KICKOFF_PROMPT.md` — the loop you are running.
3. `docs/rfc-incremental-unit-substrate.md` — the source RFC. For Sprint 0, §4.1 (IU identity + state), §4.2 (`IuLedger` interface), §7 (code blueprint), and REQ-1/2/3/6 are load-bearing.
4. `research/incremental-processing-deep-dive.md` — academic grounding (the framework→IU mapping table); read for context, not required to implement C1.
5. Project memory `incremental-unit-substrate-insight` — why this substrate exists (speculative gen + barge-in truncation are the same commit/revoke op).

## Last completed sprint

`(none — Phase 0 not started)`

## Last completed at

`(none)`

## Sprint history

| Sprint | Status | Completed at | Warmdown |
|--------|--------|--------------|----------|
| 0 | not-started | — | — |
| 1 | not-started | — | — |
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
