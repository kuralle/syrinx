# Story Brief — `RL-WBS-1` HedgedReasoner (Lever C)

> **You are the IC engineer (`grok` worker — fresh process, clean context).** Self-contained. If anything contradicts disk, **stop** (`.handoff/blocked-rl-wbs-1.md`).
>
> **Commit:** one atomic `[RL-WBS-1] HedgedReasoner (Lever C)` on `plan/reasoner-latency`. No push, no main.
> **Proof:** `.handoff/proof-rl-wbs-1.json`.

---

## 1. Goal

Add `HedgedReasoner` — a composite `Reasoner` that races a `primary` against a threshold-delayed `backup`, commits to whichever emits first, aborts the loser, and forwards the committed stream verbatim. It is the "safe primitive first" of the reasoner-latency RFC (Lever C). Pure `packages/core`, no provider deps — it wraps two `Reasoner`s.

## 2. Required reading
1. `docs/rfc-reasoner-latency.md` §4 (HedgedReasoner interface), §5 (R1–R8 hard requirements), §8 WBS-1 (DoD).
2. `packages/core/src/reasoner.ts` — the `Reasoner` interface, `ReasonerTurn` (`.signal: AbortSignal`), and the `ReasoningPart` union (`text-delta | tool-call | tool-result | suspended | error | finish`; `suspended`/`error`/`finish` are terminal). **Read the §7a latency invariant in the doc-comment.**
3. `packages/core/src/provider-fallback.ts` — mirror its conventions: metrics via `this.opts.bus.push(Route.Background, make.metric(contextId, name, value))`; an injectable `Scheduler` (`opts.scheduler ?? new TimerScheduler()`) for timers (do NOT use raw `setTimeout` — tests need a fake scheduler).
4. `packages/core/src/scheduler.ts` — the `Scheduler` interface (`schedule(key, ms, cb)` / `cancel(key)`); `packages/core/src/packet-factories.ts` — `make.metric(contextId, name, value)`.
5. `packages/core/src/index.ts` — where to export.

## 3. Interface (RFC §4)
```ts
export interface HedgedReasonerOptions {
  readonly primary: Reasoner;
  readonly backup: Reasoner;         // same model / different provider, or a peer
  readonly hedgeAfterMs: number;     // fire backup only past this; bounds cost
  readonly bus?: PipelineBus;        // optional — metrics only; absent = no metrics
  readonly contextId?: string;       // metric contextId (default "")
  readonly scheduler?: Scheduler;    // injectable timer (default TimerScheduler)
}
export class HedgedReasoner implements Reasoner {
  constructor(private readonly opts: HedgedReasonerOptions) {}
  stream(turn: ReasonerTurn): AsyncIterable<ReasoningPart> { /* async generator */ }
}
```

## 4. Algorithm (implement exactly — this is the crux)

`stream` is an `async *generator`. Per turn:

1. **Child abort controllers.** `const pc = new AbortController(); const bc = new AbortController();` Link the parent: if `turn.signal.aborted` → abort both immediately and return; else `turn.signal.addEventListener("abort", () => { pc.abort(); bc.abort(); }, { once: true })`. Each backend is driven with its own child signal: `primary.stream({ ...turn, signal: pc.signal })`.
2. **Start primary now.** Get its iterator; kick `primaryFirst = it.next()` (a promise for the first part). Do NOT await to completion.
3. **Schedule the hedge.** Via `scheduler.schedule("hedge", hedgeAfterMs, …)`: when it fires (only if not already committed), start `backup.stream({ ...turn, signal: bc.signal })`, kick `backupFirst = bit.next()`, and emit metric `hedge.fired = "1"`.
4. **Commit on the first usable part.** Race the available first-part promises. "Usable" = a non-`error` first part (an `error` first part is a **pre-commit error** → fail over, do not commit that backend). On commit to backend X:
   - `scheduler.cancel("hedge")` (if pending); abort the **other** controller (R3) and call the loser iterator's `.return?.()` to release it; emit metric `hedge.committed_to = "primary"|"backup"`.
   - **Yield X's first part, then `for await` the rest of X's iterator and yield every part verbatim** (R1 no interleaving, R4 transparent passthrough — at most the one first-part hold).
5. **Pre-commit error / failover (R6).** If primary's first part is an `error` and no commit yet: if backup not started, start it now (and cancel/ignore the timer); await backup's first part; if non-`error` → commit backup; if backup also `error` (pre-commit) → yield the error part (both failed pre-commit) and return. Symmetric if backup is the one that errors first while primary still pending.
6. **Post-commit (R6).** Once committed to X, any `error`/`suspended`/`finish` from X is forwarded verbatim as the terminal part — **no failover, no swap**.
7. **Barge-in (R5).** Handled by step 1's parent-link: `turn.signal` abort → both children abort; the generator's `for await` sees the abort and ends. Do not swallow it.

**Metrics (R7):** guard on `opts.bus` — `opts.bus?.push(Route.Background, make.metric(opts.contextId ?? "", name, value))`. Emit `hedge.fired` when backup starts and `hedge.committed_to` on commit. Never emit if `bus` absent.

**R4 latency:** the only pre-commit hold is the first part. When primary wins fast (before the hedge fires), backup is never started (step 3's callback checks committed) — zero added cost, first part forwarded as soon as it lands.

## 5. Acceptance criteria — fake-Reasoner unit tests (RFC WBS-1 DoD)
`packages/core/src/reasoner-hedge.test.ts` with **two fake Reasoners** (controllable: emit parts on command, honor their `signal`) + a **fake Scheduler** (manually fire "hedge"). Prove:
1. **(a) primary fast** → primary emits before the hedge fires → backup **never started** (its `stream` never called); output = primary's parts.
2. **(b) hedge fires, primary still wins** → fire the scheduler ("hedge") so backup starts (`hedge.fired` emitted); primary then emits first → commit primary, backup aborted.
3. **(c) backup wins** → primary silent, fire hedge, backup emits first → commit backup; **no interleaving** (R1: no primary parts appear after commit).
4. **(d) loser aborted (R3)** → the losing backend's `signal.aborted === true` after commit (assert via a fake that records its signal).
5. **(e) pre-commit primary error (R6)** → primary's first part is `{type:"error"}` → fails over to backup; output = backup's parts; primary's error not forwarded.
6. **(f) post-commit error verbatim (R6)** → committed backend later emits `{type:"error"}` → forwarded as the terminal part, no failover to the other backend.
7. **Metrics** → with a fake bus, `hedge.fired` emitted iff backup started; `hedge.committed_to` reflects the winner. With **no bus**, no throw.
8. `pnpm --filter @kuralle-syrinx/core typecheck` exit 0; `pnpm --filter @kuralle-syrinx/core test` exit 0 (existing 227 + new).

## 6. What NOT to do
- Do NOT use raw `setTimeout` — use the injectable `Scheduler` (tests fire it manually).
- Do NOT buffer beyond the single first part (R4). Do NOT interleave two backends (R1).
- Do NOT modify `ProviderFallback`, `reasoner.ts`, the bridge, or any existing file except `index.ts` (add the export).
- Do NOT introduce provider deps — `reasoner-hedge.ts` wraps two `Reasoner`s and is pure.
- No `--no-verify`, `@ts-ignore`, `as any`, silent catch.

## 7. Demo
Save `pnpm --filter @kuralle-syrinx/core test` output to `sprints/reasoner-latency/artifacts/rl-wbs-1.txt`.

## 8. Proof + report
`.handoff/proof-rl-wbs-1.json`: `commands_run` = core typecheck+test (exit 0); `satisfies_assertions` = `["R1","R3","R4","R6","R7","test:hedge"]`; `files_changed`, `demo_artifact`, `notes`. Commit `[RL-WBS-1] HedgedReasoner (Lever C)`. Exit — no PR.

## 9. If stuck
If the race/failover semantics can't be made to satisfy R1/R6 cleanly, or a test reveals interleaving you can't eliminate, STOP and write `.handoff/blocked-rl-wbs-1.md` with the exact case. Do not paper over with a buffer that violates R4.
