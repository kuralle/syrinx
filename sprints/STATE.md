# Project State

> **Single source of truth for "where are we right now."** Updated at the end of every sprint warm-down.

---

## Active sprint

**Sprint number:** `2`
**Sprint name:** Mastra adapter
**Status:** `not-started`
**Goal:** A Mastra `Agent` drives the same `ReasoningBridge` via `fromMastraAgent`, with a live worker turn through a Mastra backend, the edge bundle still clean, and LLM-TTFT within budget.
**WBS section:** [`sprints/WBS.md` § Sprint 2](./WBS.md)

## Build branch

**Active build branch:** `v2`

Every sprint session — manager and IC — works **on this branch only**. Before Step 1 of the kickoff, confirm `git branch --show-current` matches. All story commits (`[S{N}-{nn}]`), fix-pass (`[S{N}-fix]`), and closeout (`[S{N}-close]`) land here. Do **not** commit to `main` mid-sprint.

At session start: `git checkout v2` (or `git fetch && git checkout v2` if missing locally).

## Load-bearing reading for sprint 2

The session running sprint 2 must read these in this order before delegating any story:

1. `sprints/sprint-1/HANDOFF.md` — read-me-first: state of the world + Mastra/edge traps carried forward.
2. `sprints/WBS.md` § Sprint 2 — stories S2-01 … S2-03.
3. `docs/rfc-reasoner-bridge.md` — §4.3 (Mastra chunk → `ReasoningPart` mapping table), §9 (edge-bundle weight + Mastra wire-shape risks), §7a (zero-delay queue, no accumulation), §8 commits 2.1–2.4.
4. `packages/voice-bridge-aisdk/src/from-ai-sdk.ts` — the adapter shape `fromMastraAgent` mirrors (one shared no-buffering mapping generator → `ReasoningPart`).
5. `packages/voice/src/reasoner.ts` — the seam contract.
6. `.understanding/bridge-rehome.md` — how `ReasoningBridge` consumes the seam (the Mastra adapter targets the same `Reasoner`).

**Carry-forward traps (from Sprint 1):** confirm `@mastra/core` wire shapes against the **pinned** version at S2-01 before finalizing the mapping (read the installed `.d.ts`); bridge the Mastra callback stream via a **zero-delay queue** (no accumulation, RFC §7a); `@mastra/core` may bloat the edge bundle — keep `verify-edge-bundle.sh` clean (runtime-split to the Node build if needed) **[hard flag]**; wire via `new ReasoningBridge(fromMastraAgent(agent))` (explicit, no auto-wrap). Gate latency with `SYRINX_WS_MAX_TURNS=1` vs the S1-00 band.

## Last completed sprint

`1 — Re-home the bridge (zero behavior change + live)`

## Last completed at

`2026-06-05`

## Sprint history

| Sprint | Status | Completed at | Warmdown |
|--------|--------|--------------|----------|
| 0 | done | 2026-06-05 | [sprint-0/WARMDOWN.md](./sprint-0/WARMDOWN.md) |
| 1 | done | 2026-06-05 | [sprint-1/WARMDOWN.md](./sprint-1/WARMDOWN.md) |
| 2 | not-started | — | — |

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
