# Story Brief — `RL-WBS-2` FIX: RoutingReasoner leaks an unhandled rejection on mispredict

> **You are the IC engineer (`grok` worker — fresh process).** Your `[RL-WBS-2]` commit (`254153d`) on `plan/reasoner-latency` is mostly correct; the manager found ONE robustness bug + one parity gap. Fix exactly these.
>
> **Commit:** one atomic `[RL-WBS-2] fix: handle rejecting route streams` on `plan/reasoner-latency`.
> **Proof:** update `.handoff/proof-rl-wbs-2.json`.

## 1. The bug (root-caused)
In `packages/core/src/reasoner-route.ts`, `streamWithSpeculation`:
```ts
const specNext = specIter.next();          // kicked
const classifiedId = await this.opts.classify(turn);
if (classifiedId === specId) { ...forward... return; }
child.abort();
releaseIterator(specIter);                 // ← specNext is now ABANDONED, no .catch
```
If the aborted spec route's `next()` **rejects** (adapters throw `AbortError` on abort), the abandoned `specNext` is an **unhandled rejection**.
**Proof:** `packages/core/src/route-throwing-spec.test.ts` (manager-authored, on disk) — currently fails with an `unhandledRejection`. Your fix must make it pass.

## 2. The fix
**(a) Mandatory — swallow the abandoned promise on mispredict:** after `child.abort(); releaseIterator(specIter);`, add `void specNext.catch(() => undefined);` (so the expected rejection from the aborted route is handled).

**(b) Parity — a thrown route stream must surface as an error part, not throw out of the generator** (match `HedgedReasoner`'s `asRacer`). Wrap the route-forwarding so a rejection becomes a terminal `{type:"error"}` part:
- The non-speculative path `yield* route.reasoner.stream(...)` and the agree-path `forwardFromIter` should both catch a thrown/rejected iteration and `yield { type: "error", cause: <Error>, recoverable: true }` then return, instead of throwing. A small helper, e.g.:
  ```ts
  private async *forwardRoute(iter, first, signal) {
    try {
      let next = first ? await first : await iter.next();
      while (!next.done) { if (signal.aborted) return; yield next.value; next = await iter.next(); }
    } catch (err) {
      yield { type: "error", cause: err instanceof Error ? err : new Error(String(err)), recoverable: true };
    }
  }
  ```
  Use it for both the agree path (pass the pulled `specNext` as `first`) and the non-spec path (start the iterator, `first = undefined`). Keep the metrics + route resolution exactly as they are.

## 3. Acceptance
1. `packages/core/src/route-throwing-spec.test.ts` **passes** (no unhandled rejection; output is only the classified route's parts).
2. All 5 existing `reasoner-route.test.ts` tests pass **unchanged**.
3. `pnpm --filter @kuralle-syrinx/core typecheck` exit 0; `pnpm --filter @kuralle-syrinx/core test` exit 0 (241 tests).
4. No `@ts-ignore`/`as any`.

## 4. What NOT to do
- Do NOT edit `route-throwing-spec.test.ts` or the 5 existing route tests.
- Do NOT change the classify/route-selection/mispredict-metric logic beyond the rejection handling.
- Touch only `reasoner-route.ts`.

## 5. Proof + report
Update `.handoff/proof-rl-wbs-2.json` (add the guard; `satisfies_assertions` += `R6-throw`). Commit `[RL-WBS-2] fix: handle rejecting route streams`. Exit — no PR.

## 6. If stuck
If parity (b) breaks a passthrough test (R8 — an extra error part where none is expected), reconsider: only convert on an actual throw; a clean stream must be byte-identical. STOP + `.handoff/blocked-rl-wbs-2.md` if you can't.
