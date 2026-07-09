# Sprint 2 — Manager review (Phase B)

**Reviewer:** Opus 4.8 (1M) manager, 2026-07-09
**Scope:** `afc77b4` `[S2-01]` on `plan/iu-substrate`
**Story:** S2-01 (C3 assistant-side IU producer). Proceed: PROCEED (round 1, no HOLD).

## Praise

- Clean, minimal, behavior-preserving: +25 lines in `index.ts`, all additive ledger calls; the existing `computeSpokenPrefix` + history rewrite are untouched. This is exactly the D-5 framing (re-express the wired heard-prefix on the ledger).
- Distinct `${contextId}#assistant` identity avoids the user-turn-IU collision I flagged in the brief.
- The IC pre-empted the S1-class bug: the mid-stream-interrupt test asserts the committed prefix is genuinely partial AND that no streamed packets are lost. Strong test design — the word-boundary test also asserts `chars < full length`, not just equality to `spoken.length`.

## Findings

| # | Severity | Area | Finding | Resolution |
|---|----------|------|---------|------------|
| 1 | minor | `commitInterruptedHistory` | `else if (committed) { assistantIu.committedPrefix = prefix }` mutates the field directly, bypassing the ledger API, to handle a completed-then-interrupted turn. | Accept — benign (no `committedPrefix` consumer yet; refines the heard span, doesn't change state). A ledger `refinePrefix` API would be cleaner; not worth it now. Noted for C4/future. |

No blockers, no majors. No `@ts-ignore`/`as any`/silent-catch/`--no-verify`.

## Regression

- `pnpm --filter @kuralle-syrinx/aisdk test` — 5 files, 42 tests green (37 existing unchanged).
- Workspace typecheck — index.ts-only change, no cross-package surface (confirmed no new failure vs baseline).

## Verdict

**Sprint 2 accepted.** The ledger now records both user-turn (S1) and assistant-response (S2) IUs, with the heard-prefix committed on barge-in — behavior-preserving. Proceed to Sprint 3 (C4: migrate the deepgram/tts poison sets into the ledger, delete dual bookkeeping).
