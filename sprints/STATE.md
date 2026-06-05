# Project State

> **Single source of truth for "where are we right now."** Updated at the end of every sprint warm-down.

---

## Active sprint

**Sprint number:** `1`
**Sprint name:** Re-home the bridge (zero behavior change + live)
**Status:** `not-started`
**Goal:** The production bridge drives a `Reasoner` internally with zero behavior change (the 9 `index.test.ts` tests' assertions unchanged; construction adapts via `fromStreamFactory` — B2), is constructed with an explicit `fromAiSdkAgent(...)` (no auto-wrap — B3), and runs a live turn on the deployed worker with LLM-TTFT within the S1-00 baseline band (M3).
**WBS section:** [`sprints/WBS.md` § Sprint 1](./WBS.md)

## Build branch

**Active build branch:** `v2`

Every sprint session — manager and IC — works **on this branch only**. Before Step 1 of the kickoff, confirm `git branch --show-current` matches. All story commits (`[S{N}-{nn}]`), fix-pass (`[S{N}-fix]`), and closeout (`[S{N}-close]`) land here. Do **not** commit to `main` mid-sprint.

At session start: `git checkout v2` (or `git fetch && git checkout v2` if missing locally).

## Load-bearing reading for sprint 1

The session running sprint 1 must read these in this order before delegating any story:

1. `sprints/sprint-0/HANDOFF.md` — read-me-first: state of the world + traps carried forward.
2. `sprints/WBS.md` § Sprint 1 — stories S1-00 … S1-03.
3. `docs/rfc-reasoner-bridge.md` — §4.4 (the generalized bridge), §4.5 (what stays verbatim — history + spoken-prefix barge-in + retry), §7a + M3 (the latency gate + baseline harness), §8 commits 1.0 / 1.3–1.5.
4. `packages/voice-bridge-aisdk/src/index.ts` — `AISDKBridgePlugin`, the bridge being re-homed; `processTurn` part-switch (`:167`) and `streamResponse` (`:263`). **Run `/code-understand` here before briefing S1-01.**
5. `packages/voice-bridge-aisdk/src/from-ai-sdk.ts` — the Sprint-0 adapter the bridge will be driven by (esp. `fromStreamFactory`, the B2 seam for the 9-test re-home).
6. `packages/voice/src/reasoner.ts` — the seam contract the bridge consumes.

**Carry-forward traps (from Sprint 0):** signal-abort (silent `return`) vs `abort` stream-part (→ `error`); `fromStreamText` must pass `maxRetries:0` (KI-0-02); validate the abnormal-terminal-`finish` → `error` decision (sprint-0 PLAN §6) against the 9 tests; S1-00 (latency baseline) runs **first**.

## Last completed sprint

`0 — Seam foundation`

## Last completed at

`2026-06-05`

## Sprint history

| Sprint | Status | Completed at | Warmdown |
|--------|--------|--------------|----------|
| 0 | done | 2026-06-05 | [sprint-0/WARMDOWN.md](./sprint-0/WARMDOWN.md) |
| 1 | not-started | — | — |

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
