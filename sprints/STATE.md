# Project State

> **Single source of truth for "where are we right now."** Updated at the end of every sprint warm-down.

---

## Active sprint

**Sprint number:** `2`
**Sprint name:** Heard-prefix commit boundary (C3)
**Status:** `not-started`
**Goal:** on barge-in, history truncates to the heard prefix through `IuLedger.commit(prefix = heard)` — the specified-but-unwired guarantee, now wired for all transports and tested (assistant-side IU).
**WBS section:** [`sprints/WBS.md` § Sprint 2](./WBS.md)
**Amendment context:** the sequence is rescoped per [`docs/rfc-incremental-unit-substrate-amendment-C5.md`](../docs/rfc-incremental-unit-substrate-amendment-C5.md) — S1=C2 (done), S2=C3, S3=C4, S4=closeout; old standalone C5 → backlog B-05.

## Build branch

**Active build branch:** `plan/iu-substrate`

Every sprint session — manager and IC — works **on this branch only**. Before Step 1 of the kickoff, confirm `git branch --show-current` matches. All story commits (`[S{N}-{nn}]`), fix-pass (`[S{N}-fix]`), and closeout (`[S{N}-close]`) land here. Do **not** commit to `main` mid-sprint — this repo's default is `main` and Phase 0 merges to it via PR after the work ships.

At session start: `git checkout plan/iu-substrate` (or `git checkout -b plan/iu-substrate` the first time, branched off `main`).

## Load-bearing reading for sprint 2

The session running sprint 2 must read these in this order before delegating any story:

1. `sprints/WBS.md` § Sprint 2 (heard-prefix commit, C3) — the plan.
2. `sprints/sprint-1/HANDOFF.md` — read-me-first from Sprint 1.
3. `docs/rfc-incremental-unit-substrate.md` §8 C3, §4.3 (`interrupt.tts` → commit-heard-then-revoke), §6, REQ-4.
4. `packages/aisdk/src/index.ts` — the barge-in path: `interrupt.llm` → `commitInterruptedHistory` (`:210-221`); the heard-prefix precision ladder (`spokenByContext`/`wordTimestampsByContext`/`playedOutMsByContext`, `:83-102`). C3 wires `ledger.commit(assistantIu, prefix=heard)` here.
5. `packages/core/src/voice-agent-session.ts` (`interrupt.tts`, `handleTurnComplete`) + `tts-playout-clock.ts` (heard-ms).
6. The S0 ledger + S1 producer pattern (`iuIdFor`) in `packages/aisdk/src/index.ts` — C3 adds the `assistant_response` IU.

## Last completed sprint

`1 — Speculative on the ledger (C2) + identity producer`

## Last completed at

`2026-07-09`

## Sprint history

| Sprint | Status | Completed at | Warmdown |
|--------|--------|--------------|----------|
| 0 | done | 2026-07-09 | [sprint-0/WARMDOWN.md](./sprint-0/WARMDOWN.md) |
| 1 | done | 2026-07-09 | [sprint-1/WARMDOWN.md](./sprint-1/WARMDOWN.md) |
| 2 | not-started | — | — |
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
