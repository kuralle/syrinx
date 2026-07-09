# Project State

> **Single source of truth for "where are we right now."** Updated at the end of every sprint warm-down.

---

## Active sprint

**Sprint number:** `1`
**Sprint name:** Speculative on the ledger (C2) + first-class turn-identity producer
**Status:** `not-started`
**Goal:** speculative generation re-expressed as an `IuLedger` consumer (behavior-preserving; `SpeculativeHold` private state gone), and the ledger gains its first producer — a `user_turn` IU keyed by `IncrementalUnitId {contextId, iuId, epoch}` with `epoch` promoted from the existing per-turn counter.
**WBS section:** [`sprints/WBS.md` § Sprint 1](./WBS.md)
**Amendment:** [`docs/rfc-incremental-unit-substrate-amendment-C5.md`](../docs/rfc-incremental-unit-substrate-amendment-C5.md) — C5 rescoped (its premise was already fixed in v4.1.0; value folds into C2). Old standalone C5 → backlog B-05.

## Build branch

**Active build branch:** `plan/iu-substrate`

Every sprint session — manager and IC — works **on this branch only**. Before Step 1 of the kickoff, confirm `git branch --show-current` matches. All story commits (`[S{N}-{nn}]`), fix-pass (`[S{N}-fix]`), and closeout (`[S{N}-close]`) land here. Do **not** commit to `main` mid-sprint — this repo's default is `main` and Phase 0 merges to it via PR after the work ships.

At session start: `git checkout plan/iu-substrate` (or `git checkout -b plan/iu-substrate` the first time, branched off `main`).

## Load-bearing reading for sprint 1

The session running sprint 1 must read these in this order before delegating any story:

1. `sprints/WBS.md` § Sprint 1 (rescoped C2 + identity producer) — the plan for this sprint.
2. `docs/rfc-incremental-unit-substrate-amendment-C5.md` — **why Sprint 1 is C2, not the standalone epoch reshape.** Read first.
3. `docs/rfc-incremental-unit-substrate.md` §8 C2, §2.2 (the speculative path already emits IU-shaped signals), §6, §7; REQ-5.
4. `packages/aisdk/src/index.ts` — the speculative path (`SpeculativeHold`, `speculativeDraft`, `activeGeneration`; staleness by `contextId` equality at `:165,212,234`). The re-expression target.
5. `packages/core/src/iu-ledger.ts` + `incremental-unit.ts` — the S0 ledger this consumes (its first producer).
6. Turn-boundary context (already mapped this session): telephony `-t<n>` per-turn rotation (`outbound-playout-pipeline.ts:46-66`); the epoch source = the existing per-turn counter.

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
