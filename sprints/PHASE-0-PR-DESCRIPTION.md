# Phase 0 — Incremental-Unit substrate (IuLedger) + ledger leak fix

**Branch:** `plan/iu-substrate` → `main`
**RFC:** `docs/rfc-incremental-unit-substrate.md` (+ amendment `docs/rfc-incremental-unit-substrate-amendment-C5.md`)
**Plan Desk:** "Syrinx vNext" → task *Build IU substrate (IuLedger + turn-epoch)*

## What this ships

The **Incremental-Unit (IU) substrate**: one in-memory `IuLedger` that records each turn's commit state (`hypothesized → committed | revoked`), plus the first two producers re-expressed onto it — behavior-preserving.

- **C1 — ledger core** (`packages/core/src/incremental-unit.ts`, `iu-ledger.ts`): `IncrementalUnit` + `InMemoryIuLedger` (add/commit/revoke/get/latest/clear), monotonic + idempotent state machine, per-`contextId`, O(1), an optional `onEvent` anomaly hook, and a **bounded** context map (FIFO cap 256).
- **C2 — speculative generation on the ledger** (`packages/aisdk/src/index.ts`): `SpeculativeHold`'s commit *state* moved to the ledger (`promoted`/`failed` gone; the side-effect buffer stays); the ledger gains its first producer — a `user_turn` IU per turn with a first-class monotonic `epoch`; `onEvent` wired to a recoverable `iu_ledger` `llm.error`.
- **C3 — assistant-side IU + heard-prefix commit** (`packages/aisdk/src/index.ts`): an `assistant_response` IU per turn (distinct `#assistant` id); on barge-in it's committed with `committedPrefix = heard span`, on clean completion committed fully — the existing heard-prefix truncation is untouched.
- **Ledger leak fix**: `InMemoryIuLedger` was unbounded (`clear()` had no production caller); now bounded (FIFO 256), mirroring the deepgram/tts `boundedAdd` pattern.

## Honest framing (please read — the reviewer is the RFC author)

The RFC was drafted from the 2026-07-02 `.understanding/` snapshot, and **two of its functional premises had already shipped in v4.1.x**:

- **C5 (telephony turn-epoch)** targeted a telephony P0 (agent goes deaf/mute after turn 1) that is **already fixed** — carriers rotate a per-turn `-t<n>` contextId (`outbound-playout-pipeline.ts:46-66`) and the poison sets are bounded. No consumer needs a first-class `epoch`. → **deferred to B-05**; C5's genuine value (ledger producer + identity) folded into C2.
- **C3's "heard-prefix is specified but unwired"** is **stale** — `computeSpokenPrefix` + `commitInterruptedHistory` already truncate to the heard prefix (v4.x G25). C3 here re-expresses that on the ledger.
- **C4 (migrate deepgram/tts poison-sets → ledger, delete dual bookkeeping)** is **net-harmful** and was NOT shipped: there is no dual bookkeeping (the sets are separate, correct, bounded, local guards), and migrating would add cross-package coupling + turn-boundary races (details in amendment §6). → **B-07**. The actionable finding — the unbounded ledger — was fixed instead.

**Net:** Phase 0 delivers the IU substrate + the two producers + a real leak fix. The RFC's advertised bug-fixes were already banked in v4.1.x; this is honest substrate + cleanup, not those fixes. Full reconciliation: the amendment doc.

## Verification

- `pnpm -r typecheck` — green except the single known pre-existing failure `examples/02-hello-voice-headless/scripts/run-studio-bargein-e2e.ts` (missing `playwright-core`).
- `pnpm -r test` — green (see the S4 gate log).
- Package suites: `@kuralle-syrinx/core` 227, `@kuralle-syrinx/aisdk` 42.
- New regression guards: `speculative-post-promotion.test.ts` (a mid-stream-promotion bug caught + fixed during C2), `heard-prefix-commit.test.ts`, `speculative-on-ledger.test.ts`, ledger-bound tests.
- Every chunk was behavior-preserving: no existing characterization test was edited; the C2 mid-stream regression was proved with a repro (passes pre-change, failed post-change) before the fix.

## Deferred (with rationale, all in the amendment)
- **B-05** — standalone `contextId`→session-id + per-turn `epoch` reshape (old C5). Consumer-gated; no consumer today.
- **B-06** — structural turn-boundary re-arm (replace the comment-driven per-turn Set clearing).
- **B-07** — migrate deepgram/tts poison-sets onto the ledger (old C4). Only if the coupling/race hazards are solved; likely never.

## Commits (on `plan/iu-substrate`)
`de43a8a` sprint OS · `1d5fe7e`/`d144d8b` C1 · `23794b1` C5 amendment · `5768440`/`3d6770a`/`46adef5` C2 (+fix) · `afc77b4`/`3cb283d` C3 · `0e23af4` C4 rescope · `71f79f2`/`dfcd6be` leak fix + close.

## Not in scope
The other three vNext RFCs (InteractionPolicy, half-cascade, reasoner-latency) — the IU substrate was Phase 0; InteractionPolicy is next.
