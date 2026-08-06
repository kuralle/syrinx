# Brief — Wire speculative and committed transcript views to their consumers

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

Write `runs/result-transcript-views.json`:

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
only to keep an existing test green — you must (1) say so explicitly in your notes,
naming the file and what changed, and (2) add a test covering it.

"The suite is green" is not evidence your change is covered. An honest declared gap
beats a silent one. A previous dispatch on this repo shipped a correct but untested
adaptation with no mention; it cost an extra dispatch to close.

---

## THE GROUND

**Repo (absolute):** `/Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx`

```bash
pnpm --filter @kuralle-syrinx/core test
pnpm -r typecheck
pnpm -r test
```

Core is at **396 tests / 34 files**. Your work must raise the count.

`pipeline-bus.test.ts`, `pipeline-bus.g10.test.ts`, `media-lane-isolation.test.ts`
and `iu-segmentation.test.ts` must pass **unmodified**.

---

## THE PLAN — where this sits (frozen snapshot)

| # | task | lane | depends on | status |
| --- | --- | --- | --- | --- |
| 1 | Add a Route.Media lane with its own drain loop | approve | — | **done** (`1e96c5b`) |
| 2 | Move media-kind pushes onto Route.Media | auto | 1 | **done** (`dece663`) |
| 3 | Cover turn_latency under two-loop ordering | auto | 2 | **done** (`8b666c0`) |
| 4 | Promote the IU ledger to session-owned segmentation | approve | 1 | **done** (`c4fd98d`) |
| 5 | **Wire speculative and committed transcript views ← YOU ARE HERE** | approve | 4 | in_progress |
| 6 | Classify interruption semantics for the reasoner | approve | 4 | todo |
| 7 | Prove the media lane end-to-end on a live call | approve | 3 | todo |

**Owned by later items — DO NOT TOUCH:** item 6 owns interruption classification.
Do not add `CORRECTION` / `CANCELLATION_REQUEST` or any typed interruption signal.

## What item 4 already built — read this before designing anything

`packages/core/src/iu-segmentation.ts` exists and is wired. It exports
`TurnSegmentation` (plus `isIuLedger`, `IU_LEDGER_CONFIG_KEY`), re-exported from
`packages/core/src/index.ts`. Its surface:

```
markBackchannel(contextId)                          // a backchannel records NO ledger entry
onSttPartial(contextId): IncrementalUnitId | undefined
onSttResult(contextId): void
onAssistantResponseStart(contextId): IncrementalUnitId | undefined
onPlayoutComplete(contextId): void
onAssistantBargeIn(contextId, playedMs): void       // commits the heard prefix
requireTranscriptIu(contextId, role): IncrementalUnitId
```

The ledger is already **written to** at every segmentation point. Every transcript
emission already carries an `iuId`. **Your task is the read side: two derived views
over what is already recorded.** Do not re-wire segmentation, do not add ledger
write points, do not change `TurnSegmentation`'s write API.

## Scope

1. Add two derived views on the session, both reading the ledger and neither reading
   raw packets:
   - `speculativeTranscript()` — hypothesized + committed IUs, newest provisional.
   - `committedTranscript()` — committed only, with `committedPrefix` applied where present.
2. Point each consumer at the right one:
   - studio / browser-client live stream → **speculative**
   - reasoner `messages`, `SessionRecord`, recording → **committed**
3. A **revoked** IU must appear in neither view.

## The two properties that make this task worth doing

Item 4 made these *possible*. This task makes them *true for consumers*, and both
must be asserted:

- **A backchannel never reaches the reasoner.** A "mm hmm" acknowledgement must not
  appear in the committed transcript, and therefore not in the history the reasoner
  reasons over. Today it can.
- **Barge-in truncates to what was heard.** When the caller interrupts at 400 ms of a
  2000 ms response, the committed view — and the reasoner's next-turn `messages` —
  must contain the 400 ms prefix, never the full generated text. The engine must not
  claim the caller heard something they did not.

## Interfaces

```ts
interface TranscriptMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly iuId: string;
  readonly state: IuState;
}

speculativeTranscript(contextId?: string): readonly TranscriptMessage[];
committedTranscript(contextId?: string): readonly TranscriptMessage[];
```

Consumers should see a **better-shaped stream, not a different type** — no breaking
change to `SessionRecord` or the wire transcript message. If you find you cannot
avoid a breaking change, stop and report `blocked` with the specific conflict.

## Validation contract

Extend `packages/core/src/iu-segmentation.test.ts` (or a sibling):

- A revoked IU appears in **neither** view.
- A hypothesized IU appears in the speculative view and **not** the committed one.
- A barge-in-truncated IU appears in the committed view at its heard prefix only, and
  the reasoner's `messages` for the next turn contain that prefix — **not** the full
  generated text.
- A backchannel appears in **neither** the committed transcript nor reasoner history.
- `packages/browser-client` session-record tests stay green **unmodified**.

**Each of the last three must bite.** Break the behaviour, watch the specific test
fail, restore, and state the observed failure (file and line) in your notes.

---

## THE SPEC — live, read this first

`Context:` http://127.0.0.1:7526/api/v1/share/plandesk_share_s8Cd05ZedAO1u4M_ACtLl_qj9cWWmYlEhseEWmpFJ7c.md
