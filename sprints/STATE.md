# Project State

> **Single source of truth for "where are we right now."** Updated at the end of every sprint warm-down.

---

## Active sprint

**Sprint number:** `1`
**Sprint name:** Turn-epoch identity (C5)
**Status:** `not-started`
**Goal:** `IncrementalUnitId {contextId, iuId, epoch}` supersedes the `contextId = turn id` overload in packets and consumers, with browser-per-turn and telephony-per-call both correct.
**WBS section:** [`sprints/WBS.md` § Sprint 1](./WBS.md)

## Build branch

**Active build branch:** `plan/iu-substrate`

Every sprint session — manager and IC — works **on this branch only**. Before Step 1 of the kickoff, confirm `git branch --show-current` matches. All story commits (`[S{N}-{nn}]`), fix-pass (`[S{N}-fix]`), and closeout (`[S{N}-close]`) land here. Do **not** commit to `main` mid-sprint — this repo's default is `main` and Phase 0 merges to it via PR after the work ships.

At session start: `git checkout plan/iu-substrate` (or `git checkout -b plan/iu-substrate` the first time, branched off `main`).

## Load-bearing reading for sprint 1

The session running sprint 1 must read these in this order before delegating any story:

1. `sprints/WBS.md` § Sprint 1 — the plan for this sprint.
2. `sprints/sprint-0/HANDOFF.md` — read-me-first from Sprint 0.
3. `docs/rfc-incremental-unit-substrate.md` — §8 C5, §2 (the `contextId = turn id` overload), §5.1 (structural before/after), REQ-1.
4. `.understanding/syrinx-voice-engine-understand.md` — the P0 turn-boundary cluster (browser mints `contextId` per turn; telephony reuses one per call; poison sets clear only on `close()`).
5. `packages/core/src/packets.ts` — where turn-scoped packets carry `contextId` today.
6. Before briefing: `/code-understand --path packages/core/src/voice-agent-session.ts` for the turn lifecycle (`eos.turn_complete`, contextId mint/consume).

## Last completed sprint

`0 — Ledger core (C1)`

## Last completed at

`2026-07-09`

## Sprint history

| Sprint | Status | Completed at | Warmdown |
|--------|--------|--------------|----------|
| 0 | done | 2026-07-09 | [sprint-0/WARMDOWN.md](./sprint-0/WARMDOWN.md) |
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
