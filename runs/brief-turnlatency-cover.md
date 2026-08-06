# Brief — Cover turn_latency emission under the two-loop drain ordering

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

Write `runs/result-turnlatency-cover.json`:

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

## THE GROUND

**Repo (absolute):** `/Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx`

```bash
pnpm --filter @kuralle-syrinx/core test
pnpm -r typecheck
pnpm -r test
```

The core suite is at **386 tests / 33 files** right now. Your work must raise the
test count — a green suite with an unchanged count means you added no coverage,
which is the exact failure this task exists to correct.

---

## THE PLAN — where this sits (frozen snapshot)

| # | task | lane | depends on | status |
| --- | --- | --- | --- | --- |
| 1 | Add a Route.Media lane with its own drain loop | approve | — | **done** (`1e96c5b`) |
| 2 | Move media-kind pushes onto Route.Media | auto | 1 | **done** (`dece663`) |
| 3 | **Cover turn_latency under two-loop ordering ← YOU ARE HERE** | auto | 2 | in_progress |
| 4 | Prove the media lane end-to-end on a live call | approve | 3 | todo (blocked by you) |
| 5 | Promote the IU ledger to session-owned turn segmentation | approve | 1 | todo |

**Owned by later items — DO NOT TOUCH:** item 5 owns `packages/core/src/iu-ledger.ts`
and turn *segmentation* in `voice-agent-session.ts`. You are touching turn
*latency* in the same file — stay inside `emitTurnLatency` /
`flushPendingTurnLatency` / `pendingTurnLatency` / the `tts.audio` handler and the
tests. Do not restructure segmentation, the IU ledger, or transcript handling.

---

## THIS IS A TEST-ONLY TASK

**Expected production diff: none.** The behaviour already shipped in `dece663`. You
are proving it, not building it.

If — and only if — writing the test reveals the adaptation is actually **wrong**,
fix it and say so explicitly in your notes. Do not "improve" working code you were
sent to cover.

## Why this is not a routine coverage chore

`tts.audio` is a `MEDIA_KIND` and drains on the **media loop**. Its latency anchors
(`vad.speech_ended`, eos) stay on `Route.Main`. The two loops are independent, so
first audio can now be dispatched **before** its anchor has been processed.
`emitTurnLatency` returns early when `anchorMs === undefined` — so the turn is
**silently dropped**. No event, no error, no metric.

`dece663` handles it: unanchored first-audio is parked in `pendingTurnLatency` and
flushed by `flushPendingTurnLatency` when the anchor lands; the pending entry is
also carried across a contextId rotation.

**That fix currently has zero test coverage, and this was demonstrated, not
guessed:** reverting `handleTtsAudio` to call `emitTurnLatency` unconditionally
leaves the whole core suite green. Nothing in 386 tests discriminates.

`turn_latency` is this project's primary latency instrument — the whole
voice-to-voice budget is measured against it. If it silently stops firing, every
downstream number becomes quietly wrong rather than visibly absent.

## The four cases to cover

1. **Audio before anchor** (the ordering the media lane made reachable): drive
   `tts.audio` on `Route.Media` and the anchor on `Route.Main` so the media loop
   wins. Assert exactly one `turn_latency`, correct `anchor`, sane `ttfaMs`.
2. **Anchor before audio** (today's normal path): still emits exactly once, and
   does **not** double-emit now that the pending path also exists.
3. **contextId rotation:** a pending entry recorded under the previous context
   survives `carryTurnTimingAcrossContextChange` and still emits.
4. **Negative:** a text-injected turn with no speech anchor still emits **nothing**.
   That early return is intended behaviour, not a bug — do not "fix" it.

## The bar for this task specifically

**Your test must bite, and you must prove it did.** Revert `handleTtsAudio` to the
unconditional `emitTurnLatency(pkt.contextId, pkt.timestampMs)`, run your new test,
watch it **fail**, then restore. State the observed failure — file and line — in
your notes.

A test that passes both with and without the fix is worthless here, and that is
precisely the state of the suite today. This task exists because a green suite was
mistaken for a covered one.

---

## THE SPEC — live, read this first

`Context:` http://127.0.0.1:7526/api/v1/share/plandesk_share_AxOMaVGB4FapNxHUaUTYttHT7N0htUGBJ5ePHeYbi9c.md
