# Brief — Add Reasoner.prewarm behind a compiler-enforced capability contract

## THE BAR (workmanship — read fully, it governs your output)

**Done means correct under the conditions it will actually face, with something
that proves it.** Not that it runs. Not that the types check.

### Hard rules

| # | Rule | Why |
| --- | --- | --- |
| 1 | No `--no-verify`, `@ts-ignore`, `@ts-nocheck`, `# type: ignore`, `try/except: pass`, `as any`, `.skip(`, "hardcode it for now" | each marks a cause to find, not a tool to reach for |
| 2 | Never edit a gate's config (`tsconfig`, test or lint config, `package.json` scripts) to make it pass | that moves the gate rather than satisfying it, and the engine checks for exactly this |
| 3 | A command goes in `claims` only if you ran it and read the exit code | there is no state between verified and absent |
| 4 | Never write "should work", "looks correct", "I believe this passes" | they are admissions of unverified state, not synonyms for done |
| 5 | If you added no test for the behaviour you changed, say so | a suite exiting 0 says the suite passed, never that your change is covered |
| 6 | Write the test so it fails first; assert against the contract (spec, RFC, vendor API), not the shape you built | a test pinned to your own output is green by construction and discriminates nothing |
| 7 | Every changed line traces to the task — no reformatting, no drive-by refactors, match surrounding style | scope creep hides the change that mattered inside noise |
| 8 | Clean up what your change orphaned; leave pre-existing dead code alone and mention it | |
| 9 | Never `git checkout` / `git restore` / `git reset` a path to undo your own mistake — fix forward | those commands take other uncommitted work in the tree with them |
| 10 | Never recover a source file from compiled output | it emits but cannot typecheck, which then invites suppressions to hide the damage |
| 11 | If the task is wrong or ambiguous, say so before building it | resolving that is a decision, and decisions belong to whoever owns the outcome |
| 12 | If the spec and the code disagree, stop and report — never pick one silently | |
| 13 | Never end on an intention: "I'll run the tests now", "next I would…" | you are headless, so a question ends the run with nothing done rather than pausing it |
| 14 | If your change accepts a caller-supplied value the server then trusts, say what stops org A supplying org B's value — and test it | an input the task did not specify arrives with no threat model attached |

Cheapest way to know a test is real (rule 6): reintroduce the bug, watch it fail, restore it.

### A guard is unverified until you have watched it fail (rule 6)

Rule 6 says write the test so it fails first. This is the same rule for guards that
are not tests — type assertions, coverage checks, manifests, golden fixtures. They
are the easiest thing in a codebase to get wrong, because a broken one is
indistinguishable from a working one: both are silent, and both leave the suite green.

One file in this repo produced **five** guards that looked sound and could not fail:
a coverage guard comparing its own constants to its own constants; `{} as
AssertEveryEntryHasImport` (a cast, so the mapped type was never checked); `true as
_GoalGuard` (an assertion to a conditional type always compiles, because `never` is
assignable to everything, so it succeeds in exactly the case it exists to catch); a
coverage snapshot projecting only the collections it already knew about; and a
canonical-ordering test that returned before asserting.

Every one passed review-by-reading. Every one failed the first sabotage.

**So: for any guard you add or touch, break the thing it guards, watch it fail, and
restore.** State the observed failure — the file and line — in your notes. "The guard
is in place" is not a claim; "I removed X, the guard failed at Y:N, I restored it" is.

- **Annotation, never assertion.** `const x: Guard = true` fails when `Guard` is `never`. `const x = true as Guard` does not.
- **A check that compares the system to a hand-maintained description of itself cannot notice what the description omits.**

A build that fails after your sabotage is not proof the *guard* fired. Confirm the
error names the guard, not collateral damage elsewhere.

If a gate cannot be satisfied honestly, report `blocked` with what you tried — a
blocked dispatch that names the wall beats a green one that hid it.

---

## THE RESULT CONTRACT — write this before you finish, whatever the outcome

Write `runs/result-route-media.json`:

```json
{
  "status": "done | blocked",
  "claims": [{ "command": "<gate or check you actually ran>", "exit_code": 0 }],
  "question": "<only when blocked: what decision or input is needed>"
}
```

- **No result file → failed**, regardless of how the code looks. Completion is this
  file, not your process exiting.
- `status: done` with no claims → invalid.
- The engine re-runs every claim. One that disagrees on re-run burns the trust that
  lets the next dispatch go unsupervised.

---

## THE RESULT CONTRACT — write this before you finish, whatever the outcome

Write `runs/result-prewarm.json`:

```json
{
  "status": "done | blocked",
  "claims": [{ "command": "<gate or check you actually ran>", "exit_code": 0 }],
  "question": "<only when blocked: what decision or input is needed>"
}
```

- **No result file → failed.** Completion is this file, not your process exiting.
- `status: done` with no claims → invalid.

---

## DISCLOSURE REQUIREMENT

If you change **any** behaviour beyond the stated scope — including a change made
only to keep an existing test green — (1) say so explicitly in your notes, naming
the file and what changed, and (2) add a test covering it. An honest declared gap
beats a silent one.

---

## THE GROUND

**Repo (absolute):** `/Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx`

```bash
pnpm --filter @kuralle-syrinx/core test
pnpm -r typecheck
pnpm -r test
```

Core is at **402 tests / 35 files**. Your work must raise the count.

`pipeline-bus.test.ts`, `pipeline-bus.g10.test.ts`, `media-lane-isolation.test.ts`,
`iu-segmentation.test.ts` and `transcript-views.test.ts` must pass **unmodified**.

**Do NOT run any live-provider smoke.** The task's contract mentions a live A/B on
`llmTtftMs`; that is a supervisor-run measurement and costs money. Do not attempt it,
do not fake it, do not put it in `claims`.

---

## THE PLAN — where this sits (frozen snapshot)

| # | task | lane | depends on | status |
| --- | --- | --- | --- | --- |
| 1 | Add a Route.Media lane | approve | — | **done** (`1e96c5b`) |
| 2 | Move media-kind pushes onto Route.Media | auto | 1 | **done** (`dece663`) |
| 3 | Cover turn_latency under two-loop ordering | auto | 2 | **done** (`8b666c0`) |
| 4 | Promote the IU ledger to session-owned segmentation | approve | 1 | **done** (`c4fd98d`) |
| 5 | Wire speculative/committed transcript views | approve | 4 | **done** (`d52ae39`) |
| 6 | **Add Reasoner.prewarm behind a capability contract ← YOU ARE HERE** | auto | — | in_progress |
| 7 | Replace history truncation with a HistoryCompactor | approve | 6 | todo |

**Owned by later items — DO NOT TOUCH:** item 7 owns `trimHistory()` /
`maxHistoryTurns` / the `HistoryCompactor` seam in `packages/aisdk/src/index.ts`.
You will be editing that file for the prewarm call chain — **do not touch history
compaction or truncation while you are in there.**

## Two defects, one cause — this is not just "add a method"

**1. The reasoner is cold on every call's first delegation.**
`PluginContract.prewarm?()` exists and `VoiceAgentSession.prewarm()` fans out to
every plugin, but the only implementation in the workspace is
`packages/openai-tts/src/index.ts`. The first delegated turn pays session setup plus
system-prompt and tool-schema prefill inside the caller's turn.

**2. Optional reasoner capabilities silently vanish through wrappers — this has
already happened.** `HedgedReasoner` (`reasoner-hedge.ts`) and `RoutingReasoner`
(`reasoner-route.ts`) implement **only `stream()`**. Every other capability on
`Reasoner` is optional, so a wrapper that forwards nothing typechecks fine.

Proof it already bit: `Reasoner.injectContext?()` is declared at `reasoner.ts:12`,
implemented by **zero** reasoner factories, and called on a reasoner **nowhere**.
Dead surface. Adding `prewarm?` under the same rules reproduces it exactly:
`RoutingReasoner(HedgedReasoner(x))` would be silently un-prewarmable, and the only
symptom would be a first-turn latency nobody can explain.

## Scope

1. **Extract `ReasonerCapabilities`** — the optional-method surface, split out of `Reasoner`.
2. **Delete `Reasoner.injectContext`.** Zero implementations, zero callers. Context
   injection keeps working via `VoiceAgentSession` → `bridge.injectContext` →
   `adapter.injectContext`, and via the cascade plugin's own `injectContext` — neither
   touches this interface member. Verify that claim before deleting.
3. **Add `prewarm?(ctx: ReasonerPrewarmContext): Promise<void>`** to the capability
   surface. Optional on reasoners, so an existing custom reasoner is unaffected.
4. **Type both wrappers so a future capability breaks compilation until forwarded.**
   Implement forwarding now:
   - `HedgedReasoner.prewarm` → **both** primary and backup (a cold backup defeats hedging).
   - `RoutingReasoner.prewarm` → **all routes, concurrently** (warming only the default
     penalizes exactly the traffic routing exists to make fast).
   Use `allSettled`, not `all` — one route failing to warm must not fail the session.
5. **Call chain runs through the plugin, not the session.** The cascade plugin owns
   the reasoner reference: `VoiceAgentSession.prewarm()` → plugin `prewarm()` →
   `reasoner.prewarm?.()`. Existing swallow-and-emit semantics: never throw, emit
   `prewarm.failed` on `Route.Background`.
6. **Guard a hanging implementation** — race the prewarm against a timeout so a wedged
   backend cannot delay session readiness.
7. **Implement it in the AI SDK reasoner** (`aisdk/src/from-ai-sdk.ts`): open the
   backend session, process the system prompt and tool schemas without producing
   user-visible output, and carry a stable affinity key on subsequent `stream()` calls
   so provider-side prompt caching hits.

## Interfaces

```ts
export interface ReasonerPrewarmContext {
  readonly sessionId: string;
  readonly systemPrompt?: string;
  readonly seedMessages?: readonly ReasonerMessage[];
}

/** The optional-capability surface. Adding here forces both wrappers to forward. */
export interface ReasonerCapabilities {
  prewarm?(ctx: ReasonerPrewarmContext): Promise<void>;
}

export interface Reasoner extends ReasonerCapabilities {
  stream(turn: ReasonerTurn): AsyncIterable<ReasoningPart>;
  // injectContext REMOVED
}

/** Wrappers implement every capability as REQUIRED — this is the enforcement. */
export type ComposedReasoner = Reasoner & Required<ReasonerCapabilities>;
```

## Validation contract

- **The compile-time enforcement is the headline.** Add a capability to
  `ReasonerCapabilities` in a type-level fixture and assert both wrappers fail to
  compile without forwarding. **If that does not fail, the contract is not doing its
  job and the whole task is decorative** — say so rather than shipping it.
- Reasoner with no `prewarm` → session reaches ready, behaves exactly as today.
- `prewarm` rejects → session still reaches ready, `prewarm.failed` observed.
- `prewarm` never resolves → session reaches ready within the timeout.
- **`RoutingReasoner(HedgedReasoner(a, b))` with three leaf reasoners → all three
  receive `prewarm` exactly once.** This is the regression test for the entire
  decision; without it the task has not been proven.
- One route's `prewarm` rejecting does not prevent the others.
- Zero references to `Reasoner.injectContext` remain; `pnpm -r typecheck` green proves
  nothing depended on it.

**Must bite:** break the wrapper forwarding, watch the three-leaf test fail, restore.
State the observed failure (file and line) in your notes.

---

## THE SPEC — live, read this first

`Context:` http://127.0.0.1:7526/api/v1/share/plandesk_share_-rtksErZG5Moib6xOGvOoC-QhRIWKNeCc_ZDQGOFbfY.md
