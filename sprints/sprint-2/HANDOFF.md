# Handoff — Sprint 2 → Sprint 3

> **One page. Read first.** Depth in [`WARMDOWN.md`](./WARMDOWN.md).

## State of the world

Sprint 2 (C3) is complete. The `IuLedger` now records both `user_turn` (S1) and `assistant_response` (S2) IUs, with the heard prefix committed on barge-in — behavior-preserving (the existing truncation is untouched). Sprint 3 is **C4**: migrate the deepgram/tts private poison/cancelled/finalized sets onto the ledger and delete them (zero-tech-debt consolidation — the substrate's headline payoff).

## Sprint 3 goal (verbatim from WBS)

**The deepgram/tts poison/cancelled/finalized sets are replaced by the ledger and deleted (zero-tech-debt), with the telephony multi-turn smoke still green (already passing pre-reshape).**

Full section: `sprints/WBS.md` § Sprint 3.

## THE key design question (resolve BEFORE delegating C4)

The `IuLedger` (`InMemoryIuLedger`) is currently instantiated **privately inside `ReasoningBridge`** (`packages/aisdk/src/index.ts`, added in S1). C4 needs `packages/deepgram/src/stt.ts` and `packages/tts-core/src/engine.ts` — **different packages** — to read/write the **same** ledger instance. Options:
1. **Shared ledger via the session/config** — the `VoiceAgentSession` (core) owns one `InMemoryIuLedger` and injects it into every plugin (bridge, stt, tts) at `initialize`. Cleanest end-state; larger wiring change (touches plugin construction).
2. **Ledger on the bus** — plugins reach a shared ledger through a bus-attached handle. Looser.
3. **Keep per-plugin ledgers, reconcile via packets** — rejected (that's the dual-bookkeeping C4 is deleting).

**Recommendation:** Option 1 (session-owned ledger, injected) — it matches RFC §12 Q2 ("standalone, instantiated by `VoiceAgentSession`"). This makes C4 partly a "move the ledger from ReasoningBridge-private to session-owned + inject" reshape, then migrate the sets. Scope it in the C4 PLAN before briefing.

## Read these first

1. `sprints/STATE.md`; `sprints/WBS.md` § Sprint 3.
2. `docs/rfc-incremental-unit-substrate.md` §8 C4, §5.1 (deleted-after-parity), REQ-3, REQ-5.
3. `packages/deepgram/src/stt.ts` — `finalizedContextIds`, `finalizeRequestedContextIds`, `speechFinalContextIds`, `boundedAdd`/`MAX_RETIRED_CONTEXTS`, `resetTurnTranscriptState`.
4. `packages/tts-core/src/engine.ts` — `cancelledContexts`, `clearCancelledIfDrained`, `MAX_CANCELLED_CONTEXTS`.
5. `packages/core/src/voice-agent-session.ts` — where a session-owned ledger would live + how plugins are constructed/initialized.
6. `packages/aisdk/src/index.ts` — the current private `iuLedger` + `iuIdFor`/`assistantIuIdFor` (to move to injection).

## Traps

- **Migrate-then-delete in one story** — do not leave the private set and the ledger both live (that's the dual bookkeeping C4 exists to remove).
- **Eviction semantics** — deepgram/tts bound their sets (`MAX_*`) and self-evict (`clearCancelledIfDrained`). The ledger has no cap/eviction. Either the ledger's `clear(contextId)` on turn/close covers it, or C4 must justify why unbounded is fine (IUs are per-context, cleared on close). Reason about memory growth explicitly.
- **The telnyx smoke is the regression guard** (`smoke:telnyx-emulator`) — already green; keep it green. Manager-run.
- `verify-handoff-proof.sh` schema drift persists — verify by re-running commands.

## Open blockers

None. Baseline green except the known `examples/02` playwright failure.

## Start by running

```bash
cd /Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx && git checkout plan/iu-substrate && cat sprints/STATE.md && pnpm --filter @kuralle-syrinx/aisdk test
```

## When done

Continue to Sprint 4 (closeout + Phase 0 PR to `main`).
