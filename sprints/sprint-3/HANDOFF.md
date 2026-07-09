# Handoff — Sprint 3 → Sprint 4 (closeout)

> **One page.** Depth in [`WARMDOWN.md`](./WARMDOWN.md).

## State of the world
Sprint 3 is complete — the IU ledger is bounded (leak fixed), and the net-harmful C4 migration was correctly skipped (B-07). **All Phase 0 substrate work is done.** Only Sprint 4 remains: closeout + the Phase 0 PR to `main`.

## Sprint 4 goal
**Phase 0 documented and PR-ready to `main`.** Write the honest PR description; present it; **do not push/open the PR without user confirmation** (outward-facing — global rule; git remote is `kuralle`).

## Phase 0 net (what the PR ships)
- C1 `InMemoryIuLedger` + `IncrementalUnit` (bounded).
- C2 speculative generation re-expressed on the ledger + first-class turn identity (epoch).
- C3 assistant-side IU + heard-prefix commit on the ledger.
- The ledger leak fix (bound).
- **Deferred/not-done, with rationale:** C5 (B-05), C4 migration (B-07), structural re-arm (B-06) — all documented in `docs/rfc-incremental-unit-substrate-amendment-C5.md`.

## Read these first
1. `sprints/STATE.md`; `sprints/WBS.md` § Sprint 4.
2. `docs/rfc-incremental-unit-substrate-amendment-C5.md` — the reconciliation the PR description must reflect.
3. `git log plan/iu-substrate` (commits listed in WARMDOWN §9).

## Traps
- The PR reviewer is the RFC author — be honest about the stale premises (C5/C3/C4 already fixed in v4.1.x).
- Verify `pnpm -r test` (not just typecheck) once before declaring PR-ready.

## Start by running
```bash
cd /Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx && cat sprints/STATE.md && git log --oneline plan/iu-substrate -12
```
