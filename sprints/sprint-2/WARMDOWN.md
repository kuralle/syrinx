# Sprint 2 — Warm-down

> **Author:** Opus 4.8 (1M) manager, 2026-07-09. **Window:** 2026-07-09.
> **Outcome:** Goal achieved — the ledger now records assistant-response IUs with the heard prefix committed on barge-in, behavior-preserving.

## 1. Goal recap

**Goal:** the ledger gains an `assistant_response` IU per turn; barge-in commits it with `committedPrefix = heard`, clean completion commits it fully — behavior-preserving.

**Hit it?** Yes, in one round (no HOLD). The existing heard-prefix truncation (already wired, D-5) is untouched; the ledger record is added alongside.

## 2. Stories shipped

| Story | Status | Commit | Demo | Notes |
|-------|--------|--------|------|-------|
| S2-01 | Done | `afc77b4` | [s2-01.txt](./artifacts/s2-01.txt) | Assistant-side IU producer + heard-prefix commit. |

## 3. What's working

- `assistant_response` IU per turn, distinct iuId `${contextId}#assistant`, same epoch as the user-turn IU.
- `add` at generation start; `commit` full on clean completion; `commit(prefix={chars,ms})` on barge-in; `revoke` if aborted/superseded uncommitted.
- The S0 `committedPrefix` field gets its first real use (the heard span).
- 42 aisdk tests green (37 unchanged + 5 new incl. the mid-stream-interrupt case).

## 4. Known issues

| ID | Description | Severity | Tracking |
|----|-------------|----------|----------|
| KI-2-01 | `commitInterruptedHistory` refines `committedPrefix` on an already-committed IU by direct field mutation (bypasses ledger API). Benign (no consumer yet). | minor | review-sprint.md #1; revisit if C4 needs a `refinePrefix` API |

## 5. Decisions

- **D-5 (recorded prior):** C3's "heard-prefix unwired" premise is stale — it's wired (v4.x G25). C3 re-expresses it on the ledger. Source: `runs/iu-substrate-implementation-notes.md` D-5; WBS § Sprint 2.
- User allocation decision: finish C3+C4 consolidation (vs pivot to a functional RFC).

## 6. RFC amendments

None new. The C5 amendment + D-5 correction govern the Phase 0 framing (consolidation, not the RFC's advertised bug-fixes).

## 7. Metrics

- aisdk tests: 42 (added 5 heard-prefix). Diff: index.ts +25, new test 291 lines. Rounds: 1 (no HOLD). Worker: grok.

## 8. Retrospective

### Keep
Enumerating the timing-sensitive cases (mid-stream interrupt, word-boundary vs ms-fallback) as explicit acceptance criteria — learned from S1's HOLD — meant the IC wrote the mid-stream test itself and there was no regression to catch. The brief investment paid the verification cost forward.

### Change
Nothing material this sprint — the front-loaded design (distinct iuId, exact insertion points) left little room to drift.

### Try next
C4 deletes real bookkeeping (deepgram `finalizedContextIds`, tts `cancelledContexts`) — the risk shifts from "behavior break" to "deleting a set with a live reader". Brief must require migrate-then-delete in one story + the deepgram/tts characterization tests green + the telnyx smoke (regression guard, already-green).

## 9. Pointers for the next sprint (C4)

- Files: `packages/deepgram/src/stt.ts` (`finalizedContextIds`, `boundedAdd`, `MAX_RETIRED_CONTEXTS`, `resetTurnTranscriptState`), `packages/tts-core/src/engine.ts` (`cancelledContexts`, `clearCancelledIfDrained`, `MAX_CANCELLED_CONTEXTS`).
- These plugins are in different packages from the bridge that owns the ledger — C4 must decide how they reach the ledger (shared instance via config/bus, or the ledger moves to a shared location). **This is the key C4 design question** — resolve it before delegating (the ledger is currently instantiated privately inside `ReasoningBridge`).
- Trap: deepgram/tts retire per-turn contextIds to drop late/duplicate packets. Migrating to the ledger means "is this context finalized/cancelled?" becomes "is the ledger IU committed/revoked?". The eviction semantics (`clearCancelledIfDrained`, bounded caps) must be preserved or provably unnecessary.
- The telnyx smoke (`smoke:telnyx-emulator`) is the regression guard — already green; C4 must keep it green.

## 10. Closeout

- [x] Story committed atomically (`afc77b4`).
- [x] Proceed + review written.
- [x] HANDOFF written; STATE → Sprint 3.
- [x] Demo artifact archived.

Sprint 2 is closed.
