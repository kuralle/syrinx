# Brief — Move media-kind pushes onto Route.Media across the workspace

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

## THE RESULT CONTRACT — write this before you finish, whatever the outcome

Write `runs/result-media-migration.json`:

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
- The engine re-runs every claim.

---

## THE GROUND

**Repo (absolute):** `/Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx`

Gate commands you must run and report:

```bash
pnpm -r typecheck
pnpm -r test
```

**The specific pass condition for this task:** `pnpm -r test` must produce **zero
media-lane dev warnings**. The previous commit added a one-time-per-kind
`console.warn` when a `MEDIA_KINDS` packet is pushed on `Route.Main`. That warning
existing in the test output IS the remaining work. Silence means migrated.

`packages/core/src/media-lane-isolation.test.ts` must keep passing, and
`pipeline-bus.test.ts` / `pipeline-bus.g10.test.ts` must stay **unmodified**.

---

## THE PLAN — where this sits (frozen snapshot)

| # | task | lane | depends on | status |
| --- | --- | --- | --- | --- |
| 1 | Add a Route.Media lane with its own drain loop | approve | — | **done** (commit `1e96c5b`) |
| 2 | **Move media-kind pushes onto Route.Media ← YOU ARE HERE** | auto | 1 | in_progress |
| 3 | Promote the IU ledger to session-owned turn segmentation | approve | 1 | todo |
| 4 | Wire speculative and committed transcript views | approve | 3 | todo |
| 5 | Prove the media lane end-to-end on a live call | approve | 2 | todo |

**Owned by later items — DO NOT TOUCH:**

- Item 3 owns `packages/core/src/iu-ledger.ts` and turn segmentation inside
  `voice-agent-session.ts`. You will be editing `voice-agent-session.ts` for the
  audio pushes — **change only the `push(Route.Main, …)` route arguments for media
  kinds there.** Do not restructure `handleUserAudio`, do not touch the IU ledger,
  do not touch transcript handling.
- Item 4 owns `packages/browser-client/src/session-record.ts`.
- Item 5 is a live-call measurement and owns no source.

## Scope boundary — read carefully

This is a **mechanical route-argument migration plus a targeted `concurrent` audit.**
It is deliberately narrow. Do not refactor, rename, or restructure anything.

`MEDIA_KINDS` (the single classification table, exported from
`packages/core/src/pipeline-bus.ts`):

`user.audio_received`, `denoise.audio`, `vad.audio`, `stt.audio`, `eos.audio`,
`tts.audio`, `record.user_audio`, `record.assistant_audio`

Call sites pushing on `Route.Main` live in roughly these files — the runtime warning
is authoritative, this list is a starting point, and **not every push in these files
is a media kind**:

`packages/core/src/voice-agent-session.ts`, `packages/core/src/turn-arbiter.ts`,
`packages/core/src/interaction-coordinator.ts`, `packages/core/src/init-chain.ts`,
`packages/core/src/idle-timeout.ts`, `packages/core/src/mode-switcher.ts`,
`packages/aisdk/src/index.ts`, `packages/cli/src/turn-runner.ts`,
`packages/cli/src/text-turn.ts`, `packages/deepgram/src/stt.ts`,
`packages/deepgram/src/tts.ts`, `packages/gemini/src/index.ts`,
`packages/openai-tts/src/index.ts`, `packages/pipecat-smart-turn/src/eos-plugin.ts`,
`packages/realtime/src/realtime-bridge.ts`, `packages/server-websocket/*.ts`,
plus `tts-core`, `stt-core`, `silero-vad`, `cartesia`, `elevenlabs`, `grok`,
`google`, `recorder`, `test`.

**Only change the route argument.** `push(Route.Main, make.vadAudio(...))` becomes
`push(Route.Media, make.vadAudio(...))` — nothing else on the line moves.

Where one `push(...)` call carries **several packets of mixed kinds**, split it:
media kinds go to `Route.Media`, the rest stay on `Route.Main`. `handleUserAudio` in
`voice-agent-session.ts` is exactly this case — it pushes `record.user_audio`,
`vad.audio`, `stt.audio` (and sometimes `eos.audio`) in one call. All four are media
kinds, so that whole call moves; check each site rather than assuming.

### The `concurrent: true` audit (action item 2 — be conservative)

Remove `{ concurrent: true }` **only** where the handler is registered for a
`MEDIA_KINDS` kind and the flag existed to dodge drain-loop parking. The media lane
now provides that structurally.

**Leave it** on genuine long-running *producer* handlers — an LLM generation loop
that emits its own packets over time is what the flag is for. If you cannot tell
which a given registration is, **leave it and say so in your notes.** A wrong
removal here silently changes dispatch ordering; a missed removal costs nothing.

### Not your job — do not attempt

The task's validation contract also names a CLI latency-harness run
(`turn_latency.queuedMs` must not regress). **That needs live provider credentials
and is run by the supervisor, not by you.** Do not attempt it, do not fake it, and
do not put it in `claims`. Your gates are `pnpm -r typecheck` and `pnpm -r test`
with zero media-lane warnings.

---

## THE SPEC — live, read this first

`Context:` http://127.0.0.1:7526/api/v1/share/plandesk_share_mzcdBPd6vAjRxI-DZ3rY3SZo8oC9QHtxYZKHuwhbxMk.md

Authoritative and possibly edited since this brief was written. Read it before
writing code.
