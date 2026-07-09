# Project State

> **Single source of truth for "where are we right now."** Updated at the end of every sprint warm-down.

---

## Active sprint

**Sprint number:** `3`
**Sprint name:** Migrate + delete dual bookkeeping (C4)
**Status:** `not-started`
**Goal:** the deepgram/tts poison/cancelled/finalized sets are replaced by the (session-owned) ledger and deleted (zero-tech-debt), with the telephony multi-turn smoke still green.
**WBS section:** [`sprints/WBS.md` § Sprint 3](./WBS.md)
**KEY design question (resolve before delegating):** the ledger is currently private to `ReasoningBridge`; C4 needs deepgram + tts (other packages) to share it. Recommendation: move to a session-owned `InMemoryIuLedger` injected into every plugin (RFC §12 Q2). See `sprints/sprint-2/HANDOFF.md`.
**Amendment context:** rescoped per [`docs/rfc-incremental-unit-substrate-amendment-C5.md`](../docs/rfc-incremental-unit-substrate-amendment-C5.md); Phase 0 back half (C3 done, C4) is zero-tech-debt consolidation (D-5).

## Build branch

**Active build branch:** `plan/iu-substrate`

Every sprint session — manager and IC — works **on this branch only**. Before Step 1 of the kickoff, confirm `git branch --show-current` matches. All story commits (`[S{N}-{nn}]`), fix-pass (`[S{N}-fix]`), and closeout (`[S{N}-close]`) land here. Do **not** commit to `main` mid-sprint — this repo's default is `main` and Phase 0 merges to it via PR after the work ships.

At session start: `git checkout plan/iu-substrate` (or `git checkout -b plan/iu-substrate` the first time, branched off `main`).

## Load-bearing reading for sprint 3

The session running sprint 3 must read these in this order before delegating any story:

1. `sprints/WBS.md` § Sprint 3 (migrate poison-sets → ledger, C4) — the plan.
2. `sprints/sprint-2/HANDOFF.md` — read-me-first, incl. THE key design question (session-owned ledger).
3. `docs/rfc-incremental-unit-substrate.md` §8 C4, §5.1 (deleted-after-parity), REQ-3, REQ-5.
4. `packages/deepgram/src/stt.ts` — `finalizedContextIds` + friends, `boundedAdd`/`MAX_RETIRED_CONTEXTS`, `resetTurnTranscriptState`.
5. `packages/tts-core/src/engine.ts` — `cancelledContexts`, `clearCancelledIfDrained`, `MAX_CANCELLED_CONTEXTS`.
6. `packages/core/src/voice-agent-session.ts` — where a session-owned ledger lives + plugin construction/initialize; `packages/aisdk/src/index.ts` — the private `iuLedger` to move to injection.

## Last completed sprint

`2 — Heard-prefix commit boundary (C3)`

## Last completed at

`2026-07-09`

## Sprint history

| Sprint | Status | Completed at | Warmdown |
|--------|--------|--------------|----------|
| 0 | done | 2026-07-09 | [sprint-0/WARMDOWN.md](./sprint-0/WARMDOWN.md) |
| 1 | done | 2026-07-09 | [sprint-1/WARMDOWN.md](./sprint-1/WARMDOWN.md) |
| 2 | done | 2026-07-09 | [sprint-2/WARMDOWN.md](./sprint-2/WARMDOWN.md) |
| 3 | not-started | — | — |
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
