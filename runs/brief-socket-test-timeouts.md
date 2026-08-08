# Stop local-server tests timing out under full-suite load

Repo: /Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx

## The bar

Two tests failed under `pnpm -r test` on 2026-08-07 while verifying **unrelated**
changes, both with `Error: Test timed out in 5000ms`, both passing 5/5 in
isolation:

- `packages/deepgram/src/tts.test.ts` — `realigns PCM split across binary frame boundaries`
- `packages/server-websocket/src/smartpbx.test.ts` — `drops SmartPBX DTMF before start with a metric and no dtmf.received packet`

Each stands up a **real local server** on `port: 0` and drives a websocket client
through it, under vitest's default 5000 ms budget. Under full-suite concurrency,
bind + handshake + round trip exceeds that on a loaded machine.

**A suite that fails on unrelated changes is worse than a slow one.** It trains
everyone to re-run instead of read, and the expensive direction is the inverse: a
real regression dismissed as "probably that flake".

## Scope — wider than the two observed failures

**14 test files across 7 packages** stand up real servers and run on the 5 s
default. All are exposed; only two have been observed failing:

| package | socket-based test files |
| --- | --- |
| server-websocket | 3 |
| deepgram | 3 |
| ws | 2 |
| grok | 2 |
| elevenlabs | 2 |
| google | 1 |
| cartesia | 1 |

`testTimeout` is **not set anywhere** in the repo. The only vitest config is
`packages/server-websocket/vitest.config.ts`, which sets
`fileParallelism: false`.

## Two things already tried that did not work — do not repeat them

- **Capping workspace concurrency** (`8f65854`, "the suite was oversubscribed, not
  flaky"). Reduced oversubscription; these tests still flake.
- **`fileParallelism: false`** in server-websocket. It is already set, and
  `smartpbx.test.ts` flaked anyway.

Reducing parallelism further is not the answer. The budget is the problem.

## Requirements

- REQ-1: Socket-based tests get a **justified** timeout, set in **one shared
  place**, not sprinkled per test. A bare per-test bump is the outcome to avoid —
  it does not survive the next test someone adds.
- REQ-2: Justify the number with a **measurement**, not a guess. Time the
  slowest socket-based test under full-suite load and state the observed figure
  and the headroom you chose in a comment beside the setting.
- REQ-3: Do not weaken any assertion, and do not add retries. A retry hides a
  genuine regression exactly as effectively as it hides a flake.
- REQ-4: `packages/server-websocket` keeps `fileParallelism: false`.
- REQ-5: Where a test's subject is a **pure function of the byte stream** and the
  server adds nothing, prefer removing the socket. `realigns PCM split across
  binary frame boundaries` is the obvious candidate — realignment is byte-stream
  logic. **Only do this if the test still covers the same behaviour.** If
  dropping the socket would change what is tested, keep the socket and rely on
  the timeout; say which you chose and why.

## Suggested shape

A shared base config at the repo root that packages with socket-based tests
extend, so the number lives once. `packages/server-websocket/vitest.config.ts`
already exists and must keep its `fileParallelism` setting while picking up the
shared timeout.

If you find a cleaner mechanism, use it — the requirement is one place, not this
specific file layout.

## Definition of done

- The two named tests pass under `pnpm -r test`.
- **Run `pnpm -r test` five consecutive times.** Report the exit code of each and
  name any test that fails in any run. A flake fix is a claim about
  distribution — one green run is not evidence, and this project has already been
  burned by exactly that.
- `pnpm -r typecheck` exits 0.
- No assertion changed, no test skipped, no retry added. State this explicitly.
- If you remove a socket from a test, **sabotage it**: break the behaviour it
  covers (mis-offset the PCM boundary join), confirm the test fails, restore, and
  quote the failure. A test that no longer needs a server must still catch the
  bug it was written for.

## Constraints

- Do not run any live smoke (`smoke:*`) — they cost provider credits and the
  manager runs them.
- Do not change `packages/core` or `examples/`.
- Do not raise timeouts for tests that do not stand up a server. Slow non-socket
  tests are a different problem and a blanket bump would hide it.

## DISCLOSURE REQUIREMENT

If you change behaviour this brief did not ask for, or add something you cannot
cover with a test, say so under `undisclosed_changes`. A silent untested
adaptation is a failed dispatch even with a green suite.

## Result contract

Write `runs/result-socket-test-timeouts.json`:

```json
{
  "task": "Stop local-server tests timing out under full-suite load",
  "status": "done | blocked",
  "claims": [{"cmd": "<command>", "exit": 0, "note": "<what it proves>"}],
  "files_touched": ["..."],
  "measured": "<slowest socket test under load, and the budget chosen>",
  "approach": "<shared timeout / socket removed / both, and why>",
  "five_runs": ["<exit codes, and any failing test names>"],
  "sabotage": "<only if a socket was removed: what you broke, the failure, restored>",
  "undisclosed_changes": "<anything beyond the brief, or 'none'>"
}
```

Then write `done` to `runs/result-socket-test-timeouts.done`.
