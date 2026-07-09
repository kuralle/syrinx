# Sprint 3 — Warm-down

> **Author:** Opus 4.8 (1M) manager, 2026-07-09. **Window:** 2026-07-09.
> **Outcome:** Goal achieved — the ledger leak is fixed (bounded); the net-harmful C4 migration was correctly NOT shipped.

## 1. Goal recap
**Goal:** `InMemoryIuLedger` no longer leaks (bounded, FIFO cap 256); the deepgram/tts migration is skipped (B-07), documented.
**Hit it?** Yes, in one round. The real bug (unbounded ledger) is fixed; the migration that would have added coupling + races was not shipped.

## 2. Stories shipped
| Story | Status | Commit | Notes |
|-------|--------|--------|-------|
| S3-01 | Done | `71f79f2` | Bound `InMemoryIuLedger` (FIFO cap 256). |
| S3-02 | Done | (in `0e23af4` + amendment §6) | Documented the C4 non-migration. |

## 3. What's working
- The ledger caps distinct contexts at 256, evicting the oldest (FIFO) — mirrors `boundedAdd`. No more unbounded per-`contextId` growth (the telephony `-t<n>` case).
- Backward-compatible; 227 core + 42 aisdk tests green.

## 4. Known issues
None. The unbounded-growth bug (KI from the map) is fixed.

## 5. Decisions
- **D-6 (user-approved):** C4 migration is net-harmful → not shipped (B-07); fix the real leak instead. Full rationale in `docs/rfc-incremental-unit-substrate-amendment-C5.md` §6 + `runs/iu-substrate-implementation-notes.md` D-6.

## 6. RFC amendments
Amendment §6 added (C4 non-migration). The IU-substrate RFC's back half (C4, C5) is now fully reconciled against reality via the amendment.

## 7. Metrics
- core tests 227 (+2 bound). Diff: iu-ledger.ts +12. Rounds: 1. Worker: grok.

## 8. Retrospective
### Keep
The pre-delegation code map (Explore) caught that C4 was net-harmful AND surfaced the real leak — before writing a line of the wrong reshape. Mapping before briefing paid for itself three times this Phase 0 (C5, C3, C4 premises all corrected pre-build).
### Change
Nothing for this sprint. Phase-0 lesson: for a substrate RFC, verify each chunk's *premise* against current code before planning the chunk — the RFC was a snapshot, the code had moved.
### Try next (Phase 0 closeout)
S4: write the honest Phase 0 PR description (what shipped = substrate + leak fix; what the RFC advertised but was already done; what's deferred = B-05/B-06/B-07). Present PR-ready; confirm before pushing to the remote (outward-facing).

## 9. Pointers for Sprint 4 (closeout)
- Phase 0 commits on `plan/iu-substrate`: `de43a8a` (sprint OS) → `1d5fe7e`+`d144d8b` (C1) → `23794b1` (C5 amendment) → `5768440`+`3d6770a`+`46adef5` (C2) → `afc77b4`+`3cb283d` (C3) → `0e23af4` (C4 rescope) → `71f79f2` (leak fix) + this close.
- The PR description must be honest about the stale premises (C5/C3/C4) — the reviewer is the RFC author.
- Do NOT push/open the PR without user confirmation (outward-facing; global rule + git-remote is `kuralle`).

## 10. Closeout
- [x] Story committed (`71f79f2`).
- [x] Proceed + review written.
- [x] Non-migration documented (amendment §6).
- [x] HANDOFF written; STATE → Sprint 4.

Sprint 3 is closed. **Phase 0 substrate work is complete** — only closeout (S4) remains.
