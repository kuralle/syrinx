# Proceed evidence — `RL-WBS-2` RoutingReasoner (Lever B)

**Verdict (round 1):** **HOLD** → re-delegate fix.
**Manager:** Opus 4.8 (1M), 2026-07-09 · **Commit:** `254153d` · **Worker:** grok

## What's right (kept)
- Clean impl: classify → resolve → stream; speculation pre-starts the guessed route, keeps on agree, aborts + `releaseIterator`s on mispredict **before forwarding any part** (R1/R2); unknown id throws; `turn.signal` linked; metrics guarded on `bus`; R8 passthrough. 5 behavioral tests green; scope clean; 240 core tests.

## The blocker (HOLD) — unhandled rejection on the mispredict path
**Root cause.** In `streamWithSpeculation`, `const specNext = specIter.next();` is kicked, then on the **disagree** path the spec route is aborted + released but `specNext` is **abandoned with no `.catch`**. If the aborted spec route's `next()` rejects (adapters throw `AbortError` on abort), that dangling promise is an **unhandled rejection**. (Same class as the RL-WBS-1 hedge bug.) The agree path awaits `specNext` in `forwardFromIter`, so a spec rejection there **throws out of the generator** rather than surfacing as an error part — a secondary robustness gap.

**Proof.** New guard `packages/core/src/route-throwing-spec.test.ts`: spec route throws, classify disagrees → on `254153d` an `unhandledRejection` (`Error: spec boom`) fires. Test asserts none.

## Required fix (re-delegated)
1. **Mandatory:** on the mispredict path, swallow the abandoned promise — `void specNext.catch(() => {})` before/after `child.abort()`.
2. **Parity:** convert a thrown route stream into a terminal `{type:"error"}` part (agree path + non-spec path) so `RoutingReasoner` never throws out of its generator — matching `HedgedReasoner`'s `asRacer` robustness.
Guard + all 5 existing route tests must pass.

## Decision (round 1)
**HOLD** — re-delegate. Routing logic is right; it must not leak an unhandled rejection or throw on a rejecting route.

---

## Round 2 — after fix `4dd7bf7`

**Verdict:** **PROCEED**

- Fix: `void specNext.catch(() => undefined)` on the mispredict path; `forwardFromIter` → `forwardRoute` (takes `first?: Promise`) which try/catches and yields a terminal `{type:"error"}` part on a thrown route; both the agree path and the non-spec path now route through it. Scope: `reasoner-route.ts` only.
- Manager re-run: `route-throwing-spec.test.ts` **passes** (no unhandled rejection); the 5 existing route tests **unchanged + green**; full `@kuralle-syrinx/core` suite green. R8 holds (a clean stream yields no spurious error part — the catch only fires on a throw).

→ **PROCEED**. RoutingReasoner (Lever B) done. Both composites (C + B) are now correct + robust against rejecting backends.
