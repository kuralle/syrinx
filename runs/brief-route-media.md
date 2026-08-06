# Brief — Add a Route.Media lane with its own drain loop in PipelineBus

---

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

## THE GROUND

**Repo (absolute):** `/Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx`

This is a pnpm workspace. Gate commands you must run and report:

```bash
pnpm --filter @kuralle-syrinx/core test      # your new test + existing core tests
pnpm -r typecheck                            # whole workspace
pnpm -r test                                 # whole workspace — the real gate
```

**Regression gate, non-negotiable:** `packages/core/src/pipeline-bus.test.ts` and
`packages/core/src/pipeline-bus.g10.test.ts` must pass **unmodified**. If you find
yourself editing either to make your change pass, stop and report `blocked` — that
means the behaviour change is wider than intended.

`packages/core/src/pipeline-bus.ts` is under every turn in this engine. It is the
highest-blast-radius file in the repo. Treat it accordingly.

---

## THE PLAN — where this sits (frozen snapshot, do not infer more)

| # | task | lane | depends on | status |
| --- | --- | --- | --- | --- |
| 1 | **Add a Route.Media lane with its own drain loop ← YOU ARE HERE** | approve | — | in_progress |
| 2 | Move media-kind pushes onto Route.Media across the workspace | auto | 1 | todo |
| 3 | Promote the IU ledger to session-owned turn segmentation | approve | 1 | todo |
| 4 | Wire speculative and committed transcript views to their consumers | approve | 3 | todo |
| 5 | Prove the media lane end-to-end on a live call with a slow tool | approve | 2 | todo |

**Owned by later items — DO NOT TOUCH:**

- **Item 2 owns migrating the call sites.** Your task adds `Route.Media`, the
  `MEDIA_KINDS` table, the second drain loop, and the dev warning — and stops.
  **Do NOT change any `push(Route.Main, <audio packet>)` call site anywhere in
  `packages/*/src`.** Eighteen packages push to the bus; migrating them is a
  separate dispatch. Leaving them on `Route.Main` emitting the new dev warning is
  the correct end state for this task.
- Item 3 owns `packages/core/src/iu-ledger.ts` wiring and turn segmentation in
  `voice-agent-session.ts`.
- Item 4 owns `packages/browser-client/src/session-record.ts`.

---

## THE SPEC — live, read this first

`Context:` http://127.0.0.1:7526/api/v1/share/plandesk_share_WclAzXJ60KDPMSYDrPdu2_1LlP1x2kg20NmH4rwqYPE.md

That link is the live task. It carries the full build contract: problem, action
items, the decided media-queue overflow policy, interfaces, pseudocode, and the
validation contract. **Read it before writing code** — it is authoritative and it
may have been edited since this brief was written. Do not rely on this brief's
summary where the two differ.

### Why this task exists (context the spec assumes)

A spike measured the current behaviour: with a `Route.Main` handler awaiting
2000 ms of I/O, media packets are delayed by up to **2034 ms** — a two-second audio
gap on a live call whenever a tool call is slow. A "reserved slot" alternative was
measured at 2000 ms and **falsified**. Two cooperating drain loops measured
**0.6 ms**. The design in the spec is the one that was proven; implement that, not
a variant.

The decided overflow policy for the new queue (bounded 8192, drop-oldest, emit
`pipeline.bus.media.dropped`, **never throw**) is in the spec under
"Media-queue overflow policy — decided, do not improvise". It differs deliberately
from `Route.Main`, which throws. Do not make them the same.

**Your new test must fail before your change.** Write
`packages/core/src/media-lane-isolation.test.ts` first, watch it fail against
today's single-loop bus, then implement. Report the observed pre-change failure in
your notes — that is the evidence the test discriminates.
