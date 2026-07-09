# Story Brief — `RL-WBS-2` RoutingReasoner (Lever B)

> **You are the IC engineer (`grok` worker — fresh process, clean context).** Self-contained. If anything contradicts disk, **stop** (`.handoff/blocked-rl-wbs-2.md`).
>
> **Commit:** one atomic `[RL-WBS-2] RoutingReasoner (Lever B)` on `plan/reasoner-latency`. No push, no main.
> **Proof:** `.handoff/proof-rl-wbs-2.json`.

## 1. Goal
Add `RoutingReasoner` — a composite `Reasoner` that picks one of several routes per turn via a caller-provided `classify(turn)` and streams the chosen route. Optional pre-commit speculation: pre-start a guessed route while `classify` runs, keep it iff `classify` agrees, else abort + switch **before any part is forwarded**. Pure `packages/core`, wraps `Reasoner`s.

## 2. Required reading
1. `docs/rfc-reasoner-latency.md` §4 (RoutingReasoner interface), §5 (R1/R2/R8), §8 WBS-2.
2. `packages/core/src/reasoner.ts` — `Reasoner`, `ReasonerTurn`, `ReasoningPart`, §7a latency invariant.
3. `packages/core/src/reasoner-hedge.ts` (just shipped, RL-WBS-1) — mirror its conventions: `stream` returns an async generator; injectable metrics via `opts.bus?.push(Route.Background, make.metric(opts.contextId ?? "", name, value))`; abort a discarded route via a child `AbortController` + `releaseIterator`.
4. `packages/core/src/index.ts` — where to export.

## 3. Interface (RFC §4)
```ts
export interface ReasonerRoute { readonly id: string; readonly reasoner: Reasoner; }
export interface RoutingReasonerOptions {
  readonly routes: readonly ReasonerRoute[];
  /** MUST resolve fast (small model / heuristic). Returns a route id. */
  readonly classify: (turn: ReasonerTurn) => string | Promise<string>;
  /** Optional: pre-start this route while `classify` runs; keep iff classify agrees, else abort+switch
   *  BEFORE any part is forwarded (pre-commit only — R1/R2). */
  readonly speculateRouteId?: string;
  readonly bus?: PipelineBus;
  readonly contextId?: string;
}
export class RoutingReasoner implements Reasoner {
  constructor(private readonly opts: RoutingReasonerOptions) {}
  stream(turn: ReasonerTurn): AsyncIterable<ReasoningPart> { /* async generator */ }
}
```

## 4. Algorithm
1. **Resolve the chosen route.**
   - If `speculateRouteId` is set: start that route immediately (child `AbortController`, kick its iterator), then `await classify(turn)`.
     - If `classify` returns the speculated id → **keep** the in-flight speculative stream; emit `route.selected = <id>`; forward it verbatim.
     - Else → **abort** the speculative route's child signal + `releaseIterator` it (no part forwarded from it — R1/R2), emit `route.mispredict = "1"`, start the classified route fresh, emit `route.selected = <classified id>`, forward it.
   - If `speculateRouteId` is not set: `await classify(turn)`, pick the route, emit `route.selected`, stream it.
2. **Pick the route by id** from `routes`; if `classify` returns an unknown id, throw a clear error (or fall to a documented default — prefer **throw** with the id, since a misconfigured classify is a bug, not a latency case).
3. **Forward the chosen route verbatim** (async-for over its iterator), honoring `turn.signal` (drive the route with a child signal linked to `turn.signal`, OR pass `turn.signal` through — simplest: pass `{ ...turn, signal: turn.signal }` for the non-speculative path; for the speculative path use a child so you can abort a mispredicted route without aborting the turn). R4: no buffering — yield each part as it lands.
4. **R8 passthrough:** a single-route config whose `classify` returns that route id must be byte-identical to streaming that route directly (no added parts, at most a microtask + the classify await).

**Metrics:** `route.selected` = chosen id; `route.mispredict` = "1" when a speculation is discarded. Guard on `opts.bus`.

## 5. Acceptance criteria — `packages/core/src/reasoner-route.test.ts` (fake Reasoners)
1. **classify routing:** `classify` returns "fast" → the "fast" route streams; "deep" → the "deep" route streams. Assert the chosen route's parts appear and the other route's `stream` was **never called** (no speculation case).
2. **speculation kept (agree):** `speculateRouteId: "fast"`, `classify` resolves "fast" → the speculative stream is kept (its `stream` called once, not restarted); `route.selected: "fast"`; no `route.mispredict`.
3. **speculation discarded (disagree):** `speculateRouteId: "fast"`, `classify` resolves "deep" → the "fast" route is aborted (`fast.capturedSignal.aborted === true`) with **no forwarded part from it** (output = only "deep" parts, exact `toEqual`); `route.mispredict: "1"`; `route.selected: "deep"`.
4. **R8 passthrough:** single route, `classify` → that id → output `toEqual` the route's parts exactly.
5. **unknown id:** `classify` returns an id not in `routes` → throws a clear error (test asserts the throw).
6. `pnpm --filter @kuralle-syrinx/core typecheck` exit 0; `pnpm --filter @kuralle-syrinx/core test` exit 0 (235 existing + new).

## 6. What NOT to do
- Do NOT forward any part from a mispredicted/discarded speculative route (R1/R2 — commit only after classify agrees).
- Do NOT buffer (R4). Do NOT use raw `setTimeout`. Do NOT touch `reasoner-hedge.ts`, `reasoner.ts`, the bridge, or any file except `reasoner-route.ts` + `index.ts` (export).
- No `--no-verify`, `@ts-ignore`, `as any`, silent catch.

## 7. Demo + proof
Save `pnpm --filter @kuralle-syrinx/core test` to `sprints/reasoner-latency/artifacts/rl-wbs-2.txt`. `.handoff/proof-rl-wbs-2.json`: core typecheck+test exit 0; `satisfies_assertions` = `["R1","R2","R8","test:route"]`. Commit `[RL-WBS-2] RoutingReasoner (Lever B)`. Exit — no PR.

## 8. If stuck
If the speculation abort-before-forward (R1/R2) can't be made clean, STOP and write `.handoff/blocked-rl-wbs-2.md`.
