# Proceed evidence — `S1-01` Speculative-on-ledger + identity producer

**Verdict:** **HOLD** (round 1) → re-delegate fix.
**Manager:** Opus 4.8 (1M), 2026-07-09
**Commit under review:** `5768440` `[S1-01]` on `plan/iu-substrate`
**Worker:** grok

## What's right (kept)

- The ledger re-expression matches manager decision D-4: `SpeculativeHold` shrunk to `{ buffered }`; `promoted`/`failed` moved to ledger state; `add`/`commit`/`revoke` wired; `onEvent` → recoverable `iu_ledger` `llm.error` (Background). `packets.ts` `component` union extended to include `iu_ledger` — minimal, necessary, in-brief.
- The 4 existing speculative tests are **unchanged** and green; `aisdk typecheck`+`test` exit 0 (grok's proof, re-run by manager).
- Scope clean: only `aisdk/index.ts`, the new test, and the `packets.ts` union line.

## The blocker (HOLD) — a real behavior regression the existing tests miss

**Root cause.** grok hoisted the per-push buffering decision into a single value computed once at `processTurn` start:
```ts
const speculativeHold = (hold && iuId && this.iuLedger.get(iuId)?.state !== "committed") ? hold : undefined;
```
The original re-checked the gate **per push** (`if (hold && !hold.promoted)`), so when `eos.turn_complete` promotes a draft **mid-stream**, subsequent deltas go live. With the decision frozen, after a mid-stream commit the still-streaming generation keeps buffering into the (already-spliced, orphaned) `hold.buffered` array — the entire post-promotion tail, **including `llm.done`**, is lost.

**Why the 4 tests didn't catch it.** They finish the generator fully before pushing `turnComplete` (e.g. `index.test.ts:815-816,824-831`), so nothing streams past promotion.

**Proof (built the signal, not a hypothesis).** New regression test `packages/aisdk/src/speculative-post-promotion.test.ts` streams a delta after a mid-stream promotion:
- pre-S1-01 `index.ts` (`d144d8b`): **PASSES** (post-promotion delta + `llm.done` reach the bus).
- S1-01 `index.ts` (`5768440`): **FAILS** — `waitFor(llm.done)` times out; the tail is lost.

This is the RFC §11 behavior-preservation violation: green existing tests ≠ preserved behavior.

## Required fix (re-delegated to grok)

Restore per-push semantics: the `push`/`defer` closures must re-check `this.iuLedger.get(iuId)?.state !== "committed"` **at call time**, not read a value captured once at `processTurn` start. The new regression guard (`speculative-post-promotion.test.ts`) plus all existing aisdk tests must be green.

## Decision (round 1)

**HOLD** — re-delegate the fix. The ledger wiring is correct; only the buffering-gate hoist must be reverted to a per-call check.

---

## Round 2 — after fix `3d6770a` `[S1-01] fix: per-push commit-state check`

**Verdict:** **PROCEED**

**Fix diff (read):** `const speculativeHold = …` (captured once) → `const isBuffering = (): boolean => …` (re-evaluated per call), applied at all three sites (`push`, `defer`, `runStore.save`). `hold!` is safe (`isBuffering()` is false when `hold` is undefined). Ledger wiring / `onEvent` / epoch from round 1 untouched. Scope: `index.ts` only, 7 insertions / 9 deletions.

**Manager re-run (authoritative):**
| Check | Result |
|-------|--------|
| `pnpm --filter @kuralle-syrinx/aisdk exec vitest run src/speculative-post-promotion.test.ts` | PASS (post-promotion tail + `llm.done` reach the bus) |
| `pnpm --filter @kuralle-syrinx/aisdk typecheck` | exit 0 |
| `pnpm --filter @kuralle-syrinx/aisdk test` | exit 0 — **4 files, 37 tests** (4 existing speculative unchanged + 4 `speculative-on-ledger` + regression guard) |

**Ledger test coverage** (`speculative-on-ledger.test.ts`): add→hypothesized+commit (epoch id), retracted→revoke, double-commit→`iu_ledger` anomaly on the bus, monotonic epoch across contextIds. Regression guard (`speculative-post-promotion.test.ts`) locks the fix.

**Note:** the regression guard is manager-authored and lands committed in `[S1-close]` (it was untracked during the fix delegation).

→ **PROCEED** to Phase B.
