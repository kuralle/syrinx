# Story Brief — `S3-01` Bound the IuLedger (leak fix)

> **You are the IC engineer (`grok` worker — fresh process, clean context).** Self-contained. If anything contradicts disk, **stop** (`.handoff/blocked-s3-01.md`).
>
> **Commit:** one atomic `[S3-01] Bound InMemoryIuLedger (leak fix)` on `plan/iu-substrate`. No push, no `main`.
> **Proof:** `.handoff/proof-s3-01.json`.
> **Behavior-preserving:** existing core (225) + aisdk (42) tests must pass **unchanged**.

---

## 1. The bug (root-caused)

`InMemoryIuLedger` (`packages/core/src/iu-ledger.ts`) never evicts. `clear(contextId)` exists but has **no production caller** (grep: only its own test). Sprints 1–2 `add` a `user_turn` + `assistant_response` IU per turn; nothing removes them. Telephony mints a new `contextId` (`<base>-t<n>`) every turn, so the `byCtx` Map grows without bound for the life of a call. The private sets this ledger sits beside are bounded to 256 for exactly this reason (`packages/deepgram/src/stt.ts:52-61` `boundedAdd`/`MAX_RETIRED_CONTEXTS=256`).

## 2. The fix — bound the ledger (mirror `boundedAdd`)

**2a. `packages/core/src/iu-ledger.ts` — add a `maxContexts` cap:**
- Constructor becomes (backward-compatible — the existing `new InMemoryIuLedger(onEvent)` call in `packages/aisdk/src/index.ts` must still compile):
  ```ts
  constructor(
    private readonly onEvent: (a: IuLedgerAnomaly) => void = () => {},
    private readonly maxContexts: number = 256,
  ) {}
  ```
- In `add(iu)`, before inserting a **new** context, evict the oldest if at cap (FIFO — `Map` preserves insertion order, so the first key is the oldest):
  ```ts
  add(iu: IncrementalUnit): void {
    const ctx = iu.id.contextId;
    if (!this.byCtx.has(ctx) && this.byCtx.size >= this.maxContexts) {
      const oldest = this.byCtx.keys().next().value;
      if (oldest !== undefined) this.byCtx.delete(oldest);
    }
    this.ctxMap(ctx).set(iu.id.iuId, iu);
  }
  ```
  (Adding another IU to an **existing** context does not count as a new context and does not evict.)
- Leave `commit`/`revoke`/`get`/`latest`/`clear` unchanged.

**2b. `packages/aisdk/src/index.ts` — release the ledger on `close()`:**
- In `close()` (where the other per-ctx maps are already cleared — `spokenByContext.clear()` etc.), the private `iuLedger` is dropped when the bridge is GC'd, but for tidiness clear its contexts too. Since `IuLedger` has no `clearAll`, the simplest correct release is to **re-assign a fresh ledger** is wrong (close means done) — instead just leave it; the bound already caps memory and the bridge is discarded. **If** you want an explicit release, iterate the contexts the bridge knows (it does not track them) — so DO NOT add per-context tracking just for this. **Decision: no code needed in `close()` beyond what exists** — the bound (2a) is the complete leak fix. (This bullet exists so you don't over-engineer a `clearAll`; skip it.)

> Net: the ONLY code change is 2a (bound `add`). Do not add per-turn `clear` wiring (a late barge-in may still need a just-completed turn's IU; the bound handles growth).

## 3. Acceptance criteria (pass ALL)

1. `InMemoryIuLedger` caps distinct contexts at `maxContexts` (default 256): adding a new context when at cap evicts the **oldest** (FIFO); adding IUs to existing contexts never evicts.
2. `new InMemoryIuLedger(onEvent)` (one arg) still compiles + behaves as before; `new InMemoryIuLedger(onEvent, 3)` uses cap 3.
3. New tests in `packages/core/src/iu-ledger.test.ts`:
   - with cap 3, adding contexts `a,b,c,d` evicts `a` (get(a) → undefined; b/c/d present).
   - adding a second IU to an existing context does not evict.
   - per-ctx isolation + the existing monotonicity/idempotency tests remain green.
4. `pnpm --filter @kuralle-syrinx/core typecheck && test` exit 0 (225 existing + new tests green).
5. `pnpm --filter @kuralle-syrinx/aisdk test` exit 0 (42 tests unchanged — the default cap 256 never evicts in those tests).
6. `pnpm -r typecheck` no new failure vs baseline (only known `examples/02`).

## 4. What NOT to do
- Do NOT touch deepgram, tts-core, transports, or `voice-agent-session.ts`. **The deepgram/tts migration is explicitly NOT part of this story** (it was rescoped out — see the PLAN).
- Do NOT wire per-turn `clear`. Do NOT add context-tracking to the bridge for a `clearAll`.
- Do NOT change `commit`/`revoke`/`get`/`latest` semantics.
- Do NOT edit existing tests.
- No `--no-verify`, `@ts-ignore`, `as any`, silent catch.

## 5. Demo
Save `pnpm --filter @kuralle-syrinx/core test` output to `sprints/sprint-3/artifacts/s3-01.txt`.

## 6. Proof + report
`.handoff/proof-s3-01.json`: `commands_run` = core typecheck+test, aisdk test (exit 0 each); `satisfies_assertions` = `["REQ-6","test:iu-ledger-bound","test:existing-unchanged"]`; `files_changed`, `demo_artifact`, `notes`. Commit `[S3-01] Bound InMemoryIuLedger (leak fix)`. Exit — no PR.

## 7. If stuck
If an existing test flips, or the constructor change breaks the aisdk call site and you can't keep it backward-compatible, STOP and write `.handoff/blocked-s3-01.md`.

Sincere work only.
