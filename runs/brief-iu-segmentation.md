# Brief — Promote the IU ledger to session-owned turn segmentation

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

Write `runs/result-iu-segmentation.json`:

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

## DISCLOSURE REQUIREMENT — read this, it is why the last dispatch was marked incomplete

If you change **any** behaviour beyond the stated scope — including a change you
had to make to keep an existing test green — you must:

1. say so explicitly in your notes, naming the file and what changed, **and**
2. add a test that covers it.

The previous dispatch on this codebase made a necessary and correct adaptation
(turn-latency ordering) and shipped it with **no test and no mention**. The suite
stayed green either way, so nothing caught it except a manual sabotage check. That
cost a whole extra dispatch to close.

"The suite is green" is not evidence your change is covered. If you cannot test
something you changed, say that plainly — an honest gap beats a silent one.

---

## THE GROUND

**Repo (absolute):** `/Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx`

```bash
pnpm --filter @kuralle-syrinx/core test
pnpm -r typecheck
pnpm -r test
```

Core is at **390 tests / 33 files**. Your work must raise the count.

`pipeline-bus.test.ts`, `pipeline-bus.g10.test.ts` and `media-lane-isolation.test.ts`
must pass **unmodified**.

---

## THE PLAN — where this sits (frozen snapshot)

| # | task | lane | depends on | status |
| --- | --- | --- | --- | --- |
| 1 | Add a Route.Media lane with its own drain loop | approve | — | **done** (`1e96c5b`) |
| 2 | Move media-kind pushes onto Route.Media | auto | 1 | **done** (`dece663`) |
| 3 | Cover turn_latency under two-loop ordering | auto | 2 | **done** (`8b666c0`) |
| 4 | **Promote the IU ledger to session-owned segmentation ← YOU ARE HERE** | approve | 1 | in_progress |
| 5 | Wire speculative and committed transcript views to consumers | approve | 4 | todo |
| 6 | Classify interruption semantics for the reasoner | approve | 4 | todo |

**Owned by later items — DO NOT TOUCH:**

- **Item 5 owns the two derived views.** Do NOT add `speculativeTranscript()` or
  `committedTranscript()`, and do NOT repoint any consumer (studio, browser-client,
  `SessionRecord`, recording, reasoner `messages`) at a new view. Your job is to make
  the ledger the thing that *records* segmentation. Reading it back through two views
  is the next task. Touching `packages/browser-client/src/session-record.ts` means you
  have gone too far.
- **Item 6 owns interruption classification.** Do not add `CORRECTION` /
  `CANCELLATION_REQUEST` or any typed interruption signal.

## Scope — what this task is

Make the ledger **session-owned and written to**. Nothing reads back through it yet.

1. Construct one `IuLedger` per session in `VoiceAgentSession` and expose it to the
   components that segment turns.
2. Wire user speech: `stt.partial` → `add({ kind: "user_turn", state: "hypothesized" })`;
   `stt.result` → `commit(id)`. Handlers are registered at
   `voice-agent-session.ts:791-792` (`handleSttPartial`, `handleSttResult`).
3. Wire assistant speech: response start → `add({ kind: "assistant_response", state:
   "hypothesized" })`; playout complete → `commit(id)`; barge-in →
   `commit(id, { ms: playedMs })` then `revoke` the untruncated tail.
   `tts.playout_progress` is handled at `voice-agent-session.ts:827`.
4. **Backchannel exclusion:** an `InteractionDecision` of kind `backchannel` creates
   **no** ledger entry. Assert this in a test rather than relying on the cue path
   happening not to create one — that is the whole point of the requirement.
5. Route the ledger's `IuLedgerAnomaly` callback into the existing observability seam
   so `unknown_iu` / `terminal_op` surface instead of being swallowed.

## The constraint that will bite you

`packages/aisdk/src/index.ts` **already owns an `InMemoryIuLedger`** (constructed at
`:166`, used at `:212`, `:290`, `:319`) for speculative user-turn hold/promote. That
must keep working.

It becomes a **second consumer of the same ledger, not a competing one.** Do not
delete it, do not leave two independent ledgers silently disagreeing about the same
turn, and do not break speculative generation. If reconciling the two turns out to
need a design decision rather than a wiring change, **report `blocked` and say what
the decision is** — do not pick one silently.

## Validation contract

New `packages/core/src/iu-segmentation.test.ts`:

- Every emitted transcript message carries a ledger id — no message reaches a consumer
  without passing through the ledger.
- A `backchannel` decision yields **zero** ledger entries and zero reasoner-history entries.
- Barge-in at 400ms of a 2000ms response leaves the assistant IU committed with
  `committedPrefix.ms === 400`.
- Ledger anomalies reach the observability sink.

**Each test must bite.** For at least the backchannel-exclusion and barge-in-prefix
cases: break the behaviour, watch the test fail, restore, and state the observed
failure (file and line) in your notes.

---

## THE SPEC — live, read this first

`Context:` http://127.0.0.1:7526/api/v1/share/plandesk_share_AEZ7wmTW7qXHhWE-V89iGCp1ElQjNt0o0zWJJvKMc0A.md
