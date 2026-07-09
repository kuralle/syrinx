# Proceed evidence — `RL-WBS-1` HedgedReasoner (Lever C)

**Verdict:** **HOLD** (round 1) → re-delegate fix.
**Manager:** Opus 4.8 (1M), 2026-07-09
**Commit under review:** `d512aa0` `[RL-WBS-1]` on `plan/reasoner-latency`
**Worker:** grok

## What's right (kept)

- Clean, correct-for-contract-compliant-backends implementation: `doStream` forwards only the committed iterator (R1 no interleaving), holds only the first part pre-commit (R4), aborts + `releaseIterator`s the loser on commit (R3), fails over on a pre-commit **error part** and forwards post-commit errors verbatim (R6), links `turn.signal` to both children (R5), guards metrics on `bus` (R7). The `repoll` mechanism correctly handles "backup starts mid-wait." Injectable `Scheduler` (no raw `setTimeout`).
- grok's 7 tests are **behavioral** (assert `loser.capturedSignal.aborted === true`, winner-not-aborted, exact `toEqual` for no-interleaving, pre/post-commit error, metrics + no-bus). Core suite 234 green; scope clean.

## The blocker (HOLD) — hangs when a backend's `next()` throws

**Root cause.** In `raceToCommit`, each racer is `next().then(...)` with **no `.catch`**. The `Reasoner` contract expects errors as `{type:"error"}` **parts**, but a backend/adapter that **throws** (rejects `next()`) — e.g. an adapter that throws `AbortError` on barge-in, or any non-compliant reasoner — makes `Promise.race(racers)` reject; the `void Promise.race(...).then(onFulfilled)` has no rejection handler, so `resolve()` is never called and the outer `await new Promise(...)` **hangs forever** (plus an unhandled rejection). grok's fake Reasoners `return` on abort and never throw, so this path is untested.

**Proof (built the signal).** New guard `packages/core/src/hedge-throwing-backend.test.ts`: primary = a Reasoner whose `stream` throws on first `next()`, backup = good. Expected: fail over to backup. Actual on `d512aa0`: **HUNG** (3s timeout) + unhandled rejection.

## Required fix (re-delegated to grok)

Catch a rejected `next()` and treat it as a **pre-commit error part** (→ the existing failover handles it): wrap each racer promise in `.catch(err => ({ who, result: { done:false, value: { type:"error", cause: <Error>, recoverable:true } } }))`. A thrown backend then fails over (if the other survives) or surfaces as the terminal error — never hangs. Keep all existing tests green + the new guard.

## Decision (round 1)

**HOLD** — re-delegate. The hedge logic is right for compliant backends; it must also not hang on a throwing one.

---

## Round 2 — after fix `6387b28`

**Verdict:** **PROCEED**

- Fix: an `asRacer(who, next)` helper wraps each racer with `.then` + `.catch`, converting a rejected `next()` into an `{type:"error"}` part; both racer sites use it. Scope: `reasoner-hedge.ts` only. No other unguarded `.then` on a `next()` promise remains.
- Manager re-run: `hedge-throwing-backend.test.ts` **passes** (2ms — was a 3s hang); the 7 existing hedge tests **unchanged + green**; full `@kuralle-syrinx/core` suite **235 passed**. typecheck 0.

The primitive is correct for compliant backends **and** robust against a throwing one. → **PROCEED**. HedgedReasoner (Lever C) done.
