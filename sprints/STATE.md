# Project State

> **Single source of truth for "where are we right now."** Updated at the end of every sprint warm-down.

---

## Active sprint

**Sprint number:** `0`
**Sprint name:** Seam foundation
**Status:** `not-started`
**Goal:** The `Reasoner` seam + `ReasoningPart` union exist in `@asyncdot/voice`, and the AI SDK adapter maps `TextStreamPart` → `ReasoningPart` with no buffering, fully unit-tested.
**WBS section:** [`sprints/WBS.md` § Sprint 0](./WBS.md)

## Build branch

**Active build branch:** `v2`

Every sprint session — manager and IC — works **on this branch only**. Before Step 1 of the kickoff, confirm `git branch --show-current` matches. All story commits (`[S{N}-{nn}]`), fix-pass (`[S{N}-fix]`), and closeout (`[S{N}-close]`) land here. Do **not** commit to `main` mid-sprint.

At session start: `git checkout v2` (or `git fetch && git checkout v2` if missing locally).

## Load-bearing reading for sprint 0

The session running sprint 0 must read these in this order before delegating any story:

1. `sprints/WBS.md` — full read; this is the plan.
2. `sprints/SESSION_KICKOFF_PROMPT.md` — the loop you are running.
3. `docs/rfc-reasoner-bridge.md` — §4.2 (the `Reasoner` seam + `ReasoningPart` union), §4.3 (AI SDK → `ReasoningPart` mapping table), §7a (the no-buffering LATENCY INVARIANT), §8 commits 1.1–1.2.
4. `packages/voice-bridge-aisdk/src/index.ts` — today's bridge being re-homed; note the `streamFactory` seam (`:77`) and the `processTurn` part-switch — the AI SDK adapter mirrors that mapping.
5. `packages/voice/src/plugin-contract.ts` + `packages/voice/src/index.ts` — the `VoicePlugin` contract and the voice package's public exports (where `Reasoner`/`ReasoningPart` are exported from).

## Last completed sprint

`(none — project not started)`

## Last completed at

`(none)`

## Sprint history

| Sprint | Status | Completed at | Warmdown |
|--------|--------|--------------|----------|
| 0 | not-started | — | — |

When a sprint completes, append a row here from `WARMDOWN.md`.

## Backlog deltas this project life

`(none — see WBS §4 for the seeded backlog: B-01 Realtime, B-02 multi-agent, B-03 @mastra/ai-sdk path, B-04 alias removal)`

## Open RFC amendments

`(none)`

---

## How to use this file

- A new session reads this file **first** to know which sprint is active and which sections of which docs are load-bearing right now.
- The session running a sprint **does not edit this file mid-sprint**. Updates land at warm-down.
- At warm-down, the session updates: active sprint pointer, **build branch** (only if it changed), load-bearing reading for the next sprint, last-completed fields, sprint history table, backlog deltas, and any open RFC amendments.
