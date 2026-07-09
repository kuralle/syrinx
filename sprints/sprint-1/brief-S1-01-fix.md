# Story Brief — `S1-01` FIX: post-promotion streaming regression

> **You are the IC engineer (`grok` worker — fresh process, clean context).** Your prior `[S1-01]` commit (`5768440`) is on the branch `plan/iu-substrate` and is mostly correct, but the manager's proceed evidence found **one behavior regression**. Fix exactly that. Self-contained brief.
>
> **Commit:** one atomic commit `[S1-01] fix: per-push commit-state check` on `plan/iu-substrate`. Do NOT push, do NOT touch `main`.
> **Proof:** update `.handoff/proof-s1-01.json` (add the new regression command).

---

## 1. The bug (root-caused by the manager — this is the ONLY thing to fix)

In `packages/aisdk/src/index.ts`, `processTurn` computes the speculative buffering gate **once**:
```ts
const speculativeHold =
  hold !== undefined && iuId !== undefined && this.iuLedger.get(iuId)?.state !== "committed"
    ? hold
    : undefined;
```
Then `push`/`defer` test `if (speculativeHold) { … buffer … }`.

This is wrong: the value is frozen at generation start. The **original** code re-checked the gate on **every** push (`if (hold && !hold.promoted)`). When `eos.turn_complete` promotes (commits) a draft **while the generation is still streaming**, the original sends subsequent deltas live; the new code keeps buffering them into the already-spliced/orphaned `hold.buffered` array, so the **entire post-promotion tail — including `llm.done` — is lost.**

## 2. The fix

Make the buffering decision **per call** again, reading the ledger state at push time (not a captured const). E.g. remove the hoisted `const speculativeHold` and inline the check inside `push`/`defer`:

```ts
const isBuffering = (): boolean =>
  hold !== undefined && iuId !== undefined && this.iuLedger.get(iuId)?.state !== "committed";

const push = <T extends Parameters<PipelineBus["push"]>[1]>(route: Route, packet: T): void => {
  if (isBuffering()) {
    if ((packet as { kind?: string }).kind === "llm.error" && iuId) this.iuLedger.revoke(iuId);
    hold!.buffered.push(() => this.bus?.push(route, packet));
    return;
  }
  this.bus?.push(route, packet);
};
const defer = (fn: () => void): void => {
  if (isBuffering()) hold!.buffered.push(fn);
  else fn();
};
```
(Also update the `runStore.save` buffering branch near the old `:434` hunk to use `isBuffering()` the same way.) Keep everything else from your `[S1-01]` commit intact — the ledger `add`/`commit`/`revoke`, `onEvent`, epoch, and the removal of `promoted`/`failed` were all correct. The `hold!` non-null assertion is justified because `isBuffering()` returns false when `hold` is undefined; if you prefer, capture `const h = hold` guarded — but do NOT reintroduce a captured *state* boolean.

## 3. Files
- **Modify:** `packages/aisdk/src/index.ts` (only the `push`/`defer`/`runStore.save` buffering gate — un-hoist it).
- **Do NOT modify:** the new regression test `packages/aisdk/src/speculative-post-promotion.test.ts` (the manager wrote it; your fix must make it pass). Do not touch any other file.

## 4. Acceptance

1. `pnpm --filter @kuralle-syrinx/aisdk exec vitest run src/speculative-post-promotion.test.ts` — **PASSES** (the post-promotion delta + `llm.done` reach the bus).
2. `pnpm --filter @kuralle-syrinx/aisdk test` — all green (the 4 existing speculative tests still unchanged + your `speculative-on-ledger.test.ts` + the new regression guard).
3. `pnpm --filter @kuralle-syrinx/aisdk typecheck` — exit 0 (strict; no `@ts-ignore`/`as any`).
4. No captured *state* boolean reintroduced; the gate is re-evaluated per push.

## 5. What NOT to do
- Do not edit the regression test or any existing test.
- Do not revert the ledger wiring / `onEvent` / epoch from `[S1-01]`.
- Do not touch other packages, transports, or `contextId` semantics.
- No `--no-verify`, `@ts-ignore`, `as any`.

## 6. Proof + report
Update `.handoff/proof-s1-01.json`: add `pnpm --filter @kuralle-syrinx/aisdk exec vitest run src/speculative-post-promotion.test.ts` (exit 0) to `commands_run[]`; add `test:speculative-post-promotion` to `satisfies_assertions`. Commit `[S1-01] fix: per-push commit-state check`. Exit — no PR.

## 7. If stuck
If making the regression test pass breaks an existing test, STOP and write `.handoff/blocked-s1-01.md` — do not paper over it.
