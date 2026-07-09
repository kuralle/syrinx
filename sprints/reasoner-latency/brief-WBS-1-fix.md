# Story Brief — `RL-WBS-1` FIX: HedgedReasoner hangs when a backend throws

> **You are the IC engineer (`grok` worker — fresh process).** Your `[RL-WBS-1]` commit (`d512aa0`) on `plan/reasoner-latency` is mostly correct; the manager found ONE robustness bug. Fix exactly that.
>
> **Commit:** one atomic `[RL-WBS-1] fix: catch rejecting backend in hedge race` on `plan/reasoner-latency`.
> **Proof:** update `.handoff/proof-rl-wbs-1.json`.

## 1. The bug (root-caused)

In `packages/core/src/reasoner-hedge.ts`, `raceToCommit` builds racers as:
```ts
racers.push(primaryNext.then((result) => ({ who: "primary" as const, result })));
racers.push(backupNext.then((result) => ({ who: "backup" as const, result })));
```
These have **no rejection handling**. If a backend's `next()` **rejects** (throws) — e.g. an adapter that throws `AbortError` on barge-in, or any reasoner that throws instead of yielding a `{type:"error"}` part — `Promise.race(racers)` rejects, the `void Promise.race(racers).then((winner) => …)` has no `onRejected`, so `resolve()` is never called and the outer `await new Promise(...)` **hangs forever** (+ an unhandled rejection).

**Proof:** `packages/core/src/hedge-throwing-backend.test.ts` (manager-authored, already on disk) — a primary whose `stream` throws → currently HANGS. Your fix must make it pass.

## 2. The fix

Convert a rejected `next()` into a **pre-commit error part**, so the existing error-handling path fails over (or surfaces the terminal error). Wrap each racer:
```ts
const asRacer = (who: Backend, next: Promise<IteratorResult<ReasoningPart>>) =>
  next
    .then((result) => ({ who, result }))
    .catch((err): { who: Backend; result: IteratorResult<ReasoningPart> } => ({
      who,
      result: { done: false, value: { type: "error", cause: err instanceof Error ? err : new Error(String(err)), recoverable: true } },
    }));
```
Use `asRacer("primary", primaryNext)` / `asRacer("backup", backupNext)` in the racers array. A thrown backend now looks like it emitted an `error` part → your existing pre-commit-error branch marks it exhausted and fails over to the other backend; if both throw/err pre-commit, the terminal error is returned. **No other logic changes** — the error-part handling you already wrote does the rest.

Verify there is no remaining unguarded `.then` on a `next()` promise (including inside `ensureBackup` if any) that could reject unhandled.

## 3. Acceptance
1. `packages/core/src/hedge-throwing-backend.test.ts` **passes** (fails over to backup; no hang, no unhandled rejection).
2. All 7 existing `reasoner-hedge.test.ts` tests still pass **unchanged**.
3. `pnpm --filter @kuralle-syrinx/core typecheck` exit 0; `pnpm --filter @kuralle-syrinx/core test` exit 0 (235 tests: 227 + 7 hedge + 1 guard).
4. No `@ts-ignore`/`as any`; the `.catch` returns a properly-typed racer object.

## 4. What NOT to do
- Do NOT edit `hedge-throwing-backend.test.ts` or the 7 existing hedge tests.
- Do NOT change the commit/failover/abort logic beyond wrapping the racer promises.
- Do NOT touch other files except `reasoner-hedge.ts`.

## 5. Proof + report
Update `.handoff/proof-rl-wbs-1.json`: add the guard test to `commands_run`/`satisfies_assertions` (`R6-throw`). Commit `[RL-WBS-1] fix: catch rejecting backend in hedge race`. Exit — no PR.

## 6. If stuck
If making the guard pass breaks an existing hedge test, STOP and write `.handoff/blocked-rl-wbs-1.md` with the exact conflict.
