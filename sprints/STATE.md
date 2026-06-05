# Project State

> **Single source of truth for "where are we right now."** Updated at the end of every sprint warm-down.

---

## Active sprint

**Sprint number:** `3`
**Sprint name:** Suspend / resume DO path
**Status:** `not-started`
**Goal:** A Mastra workflow `suspend()` parks a run that is persisted by `runId` in the Durable Object, asked of the user, and resumed on a later voice turn — surviving DO hibernation between turns (proven in workerd).
**WBS section:** [`sprints/WBS.md` § Sprint 3](./WBS.md)

## Build branch

**Active build branch:** `v2`

Every sprint session — manager and IC — works **on this branch only**. Before Step 1 of the kickoff, confirm `git branch --show-current` matches. All story commits (`[S{N}-{nn}]`), fix-pass (`[S{N}-fix]`), and closeout (`[S{N}-close]`) land here. Do **not** commit to `main` mid-sprint.

At session start: `git checkout v2` (or `git fetch && git checkout v2` if missing locally).

## Load-bearing reading for sprint 3

The session running sprint 3 must read these in this order before delegating any story:

1. `sprints/sprint-2/HANDOFF.md` — read-me-first: state of the world + suspend/resume traps + verified Mastra API.
2. `sprints/WBS.md` § Sprint 3 — stories S3-01 … S3-04.
3. `docs/rfc-reasoner-bridge.md` — §4.6 (suspend/resume across turns + DO `runId` + **(B4)** `onResumeConflict: "restart" | "replay"`), §9, §8 commits 3.1–3.5.
4. `packages/voice/src/reasoner.ts` — `ReasoningPart.suspended` + `ReasonerTurn.resume` (exist from S0-01); S3-01 adds `reasoning.suspended`/`reasoning.resume` packets.
5. `packages/voice-bridge-mastra/src/from-mastra.ts` — the `// Sprint 3 (S3-02)` marker (`tool-call-suspended` → terminal `suspended`; `turn.resume` → `agent.resumeStream(data,{runId})`).
6. `packages/voice-server-workers/src/*` — the DO + `DurableObjectSessionStore` (mirror for `DurableObjectRunStore` on `ctx.storage.sql`). **Run `/code-understand` on the DO + suspend path before S3-03/S3-04.**
7. `packages/voice-bridge-aisdk/src/index.ts` — `ReasoningBridge` (add `suspended` handling + `onResumeConflict` + injected `RunStore`).

**Carry-forward traps (from Sprint 2):** **(B4)** spoken-prefix reconciliation on resume — `onResumeConflict` default `restart` (discard + re-ask if a barge-in landed since suspend; never `resumeStream` a stale checkpoint); the DO `{runId,contextId,payload}` row must survive **hibernation** (workerd test); the `DurableObjectRunStore` is **edge code** (SQL, Mastra-free) — the Mastra `resumeStream` runs on the Node path; suspend must add **no** latency to non-suspending turns (§7a, `SYRINX_WS_MAX_TURNS=1` vs the S1-00 band). Verified on `@mastra/core@1.41.0`: `resumeStream(resumeData,{runId,toolCallId?})` + `tool-call-suspended` (`payload.suspendPayload`) + `runId` exist. **KI-2-01:** `voice-server-websocket` smartpbx heartbeat test is timing-flaky under load — re-run in isolation.

## Last completed sprint

`2 — Mastra adapter`

## Last completed at

`2026-06-05`

## Sprint history

| Sprint | Status | Completed at | Warmdown |
|--------|--------|--------------|----------|
| 0 | done | 2026-06-05 | [sprint-0/WARMDOWN.md](./sprint-0/WARMDOWN.md) |
| 1 | done | 2026-06-05 | [sprint-1/WARMDOWN.md](./sprint-1/WARMDOWN.md) |
| 2 | done | 2026-06-05 | [sprint-2/WARMDOWN.md](./sprint-2/WARMDOWN.md) |
| 3 | not-started | — | — |

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
