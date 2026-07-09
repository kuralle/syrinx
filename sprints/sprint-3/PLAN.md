# Sprint 3 — Plan (rescoped: ledger leak fix)

**Sprint name:** Bound the ledger + skip the migration (C4, rescoped)
**Sprint goal:** the `InMemoryIuLedger` no longer leaks — it is bounded (FIFO cap on contexts, mirroring the private sets' `MAX_*=256`) — and the net-harmful deepgram/tts migration is NOT done (→ backlog B-07), documented.
**Author:** Opus 4.8 (1M) manager, 2026-07-09
**Rationale:** D-6 (`runs/iu-substrate-implementation-notes.md`) + the design-doc board comment.

## Why not the migration (recap)
C4-as-specified is net-harmful: no dual bookkeeping to delete (the deepgram/tts sets are separate, correct, bounded, LOCAL guards), and migration would increase cross-package coupling + add turn-boundary races. The actionable finding is the real bug: `InMemoryIuLedger.clear()` has no production caller, so IUs accumulate per contextId forever (telephony mints a new `-t<n>` ctx per turn). Fix = bound the ledger, the same way the sets bound themselves.

## Story `S3-01` — bound `InMemoryIuLedger`

**Description:** Add a `maxContexts` cap (default 256, constructor-configurable) to `InMemoryIuLedger`. When `add` introduces a **new** contextId and the ledger is at cap, evict the **oldest** context's entire IU map first (FIFO, mirroring `boundedAdd`/`MAX_RETIRED_CONTEXTS`). Backward-compatible constructor (existing `new InMemoryIuLedger(onEvent)` still works). Wire `clear`-all on the aisdk `ReasoningBridge.close()` for session-end release (the bound is the mid-session backstop). Do **not** wire per-turn `clear` (a late barge-in may still need a just-completed turn's IU — the bound handles growth).

**Acceptance criteria:**
1. `InMemoryIuLedger` caps tracked contexts at `maxContexts` (default 256); a 257th distinct context evicts the oldest. Existing single-context behavior unchanged.
2. Constructor stays backward-compatible: `new InMemoryIuLedger(onEvent)` compiles + behaves as before; `new InMemoryIuLedger(onEvent, 8)` uses cap 8.
3. `ReasoningBridge.close()` releases the ledger (clear-all or drop the reference) — no lingering IUs after close.
4. New `iu-ledger` tests: evict-oldest on overflow; per-ctx isolation preserved under eviction; the S0 idempotency/monotonicity tests still green.
5. All existing core (225) + aisdk (42) tests pass **unchanged**; `pnpm -r typecheck && pnpm -r test` green (known `examples/02` failure excepted).

**Files:** `packages/core/src/iu-ledger.ts` (modify), `packages/core/src/iu-ledger.test.ts` (add bound tests), `packages/aisdk/src/index.ts` (close() release — small).

**Demo:** `sprints/sprint-3/artifacts/s3-01.txt` — core test run showing the bound/evict tests green.

## Story `S3-02` — document the non-migration
Extend `docs/rfc-incremental-unit-substrate-amendment-C5.md` with a short C4 section (the D-6 rationale + B-07 pointer). No code.

## Risks

| Risk | Detection | Mitigation |
|------|-----------|------------|
| Eviction drops a context still needed mid-turn | aisdk speculative/heard-prefix tests flip | cap ≥ 256 (never 256 live turns at once); FIFO evicts only long-closed contexts — same reasoning as the private sets. |
| Constructor change breaks the aisdk call site | aisdk typecheck | additive optional param, default 256; verify the existing `new InMemoryIuLedger((a)=>{...})` still compiles. |

## Open questions
- **OQ-S3-1 (resolved):** LRU vs FIFO eviction? → FIFO (insertion order), mirroring `boundedAdd`. Simpler; a context created 256+ contexts ago is definitely closed.
- **OQ-S3-2 (resolved):** wire per-turn `clear`? → No. Only clear-on-close; the bound handles mid-session growth. Per-turn clear risks dropping an IU a late barge-in wants.
