# Project State

> **Single source of truth for "where are we right now."** Updated at the end of every sprint warm-down.

---

## Active sprint

**PROGRAM COMPLETE** — all 5 sprints (0–4) done; the WBS is complete. The Reasoner-bridge generalization is **released on `v2`** (not merged to trunk — kept on `v2` per user direction, see backlog B-07).

**Last sprint:** `4 — Polish + 1.0` (done).
**Resume point if reopened:** backlog B-07 (trunk PR) / B-05 (Mastra bundle diet) — see `sprints/WBS.md` §4 + `sprints/sprint-4/WARMDOWN.md`.

## Build branch

**Active build branch:** `v2`

Every sprint session — manager and IC — works **on this branch only**. Before Step 1 of the kickoff, confirm `git branch --show-current` matches. All story commits (`[S{N}-{nn}]`), fix-pass (`[S{N}-fix]`), and closeout (`[S{N}-close]`) land here. Do **not** commit to `main` mid-sprint.

At session start: `git checkout v2` (or `git fetch && git checkout v2` if missing locally).

## Load-bearing reading for sprint 4

The session running sprint 4 must read these in this order before any story:

1. `sprints/sprint-3/HANDOFF.md` — read-me-first: state of the world (all 3 backends working/deployed) + traps.
2. `sprints/WBS.md` § Sprint 4 — stories S4-01 … S4-03.
3. `docs/latency-budget.md` — the S1-00 baseline/band (the denominator) + where the cross-backend report (S4-01) appends.
4. `docs/rfc-reasoner-bridge.md` §7 (validation) + §9 (risk closeout, S4-03).
5. The shipped APIs to document (S4-02): `packages/voice/src/reasoner.ts`, `voice-bridge-aisdk` (`ReasoningBridge`/`from-ai-sdk`/`RunStore`), `voice-bridge-mastra` (`from-mastra`), `voice-server-workers-mastra`.

**Carry-forward traps (from Sprint 3):** **KI-3-01** — `pnpm -r test` flakes under concurrency (`voice-server-websocket`, `voice-stt-google` 5 s-timeout tests, pass in isolation, NOT Reasoner-bridge regressions) — judge green per-package. Latency report uses the **short fixture** (`SYRINX_WS_MAX_TURNS=1`) vs the S1-00 band. Mastra-edge worker is **Paid tier** (8 MB); bundle diet is backlog (KI-3-02). **No new deps** in Sprint 4 — it's report + docs + risk closeout + the trunk PR. **Capstone = `v2`→trunk PR — confirm with the user before opening/merging.** All three demos already proven: AI-SDK deployed (`cc9236aa`), Mastra Node (S2) + edge deployed (`40a15353`), suspend/resume deployed.

## Last completed sprint

`3 — Suspend / resume DO path`

## Last completed at

`2026-06-05`

## Sprint history

| Sprint | Status | Completed at | Warmdown |
|--------|--------|--------------|----------|
| 0 | done | 2026-06-05 | [sprint-0/WARMDOWN.md](./sprint-0/WARMDOWN.md) |
| 1 | done | 2026-06-05 | [sprint-1/WARMDOWN.md](./sprint-1/WARMDOWN.md) |
| 2 | done | 2026-06-05 | [sprint-2/WARMDOWN.md](./sprint-2/WARMDOWN.md) |
| 3 | done | 2026-06-05 | [sprint-3/WARMDOWN.md](./sprint-3/WARMDOWN.md) |
| 4 | done | 2026-06-05 | [sprint-4/WARMDOWN.md](./sprint-4/WARMDOWN.md) |

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
