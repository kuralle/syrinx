# Replace the iu-ledger O(1) timing test with a deterministic instrument

Repo: /Users/mithushancj/Documents/asyncdot-openscoped/voice-media-transport/syrinx
File: `packages/core/src/iu-ledger.test.ts`

## The bar

`InMemoryIuLedger > O(1) per-op (structural) > commit/get touch only the target
ctx bucket regardless of total ctx count` fails intermittently under full-suite
load and passes standalone. It flaked twice on 2026-08-06 on unrelated changes.

The **intent is sound** — a `Map` lookup is O(1), not O(contexts). The
**instrument is not**:

```ts
const timeOp = (ledger, id) => {
  const start = performance.now();
  for (let i = 0; i < 5000; i++) ledger.get(id);
  return performance.now() - start;
};
expect(tLarge).toBeLessThan(Math.max(tSmall * 20, 1));
```

Two wall-clock samples compared as a ratio. Under a parallel suite, scheduler
noise on either sample dwarfs the signal. A previous fix capped workspace
concurrency (`8f65854`) — that reduced oversubscription but did not make this
test load-independent, so the class recurred. **This test needs a different
instrument, not less load.**

## Requirements

- REQ-1: The assertion is **deterministic** — it must not read a clock, and it
  must not depend on elapsed time, scheduling, or machine speed.
- REQ-2: It asserts the real property: a hot-path op touches a number of buckets
  **independent of total context count**. Prefer counting operations over
  measuring time.
- REQ-3: Do **not** delete the test, skip it, or widen the ratio until it passes.
  A threshold loosened until green is a test that no longer discriminates.
- REQ-4: It must still bite — see the sabotage requirement below.

## Suggested approach

The ledger's internal maps are private, so count accesses rather than reaching
inside. One workable shape: temporarily wrap `Map.prototype.get` (and `set` if
relevant) with a counting wrapper for the duration of the op, run the op against
a 10-context ledger and a 1000-context ledger, and assert the **counts are
equal** — not merely similar. Restore the prototype in a `finally` so a failure
cannot leak the patch into other tests, which would be a far worse flake than the
one you are fixing.

If you find a cleaner deterministic instrument, use it and say why in your
result. The requirement is determinism and discrimination, not this specific
technique.

## Action item 3 — sweep the siblings

The task also asks whether other tests share this shape. These files use
`performance.now()`:

- `packages/core/src/voice-agent-session.test.ts`
- `packages/pipecat-smart-turn/src/interaction-policy.test.ts`
- `packages/vap/src/vap-policy.test.ts`

For each, determine whether it **compares two measured durations** (the flaky
shape) or merely records a timestamp / passes a synthetic time value (fine).
Fix only the ones that compare measured durations. **Report your finding for each
of the three explicitly**, including the ones you leave alone and why — a silent
"I looked" is not a finding.

## Out of scope — do not fix here

`packages/deepgram/src/tts.test.ts > realigns PCM split across binary frame
boundaries` also flakes under load (`Test timed out in 5000ms`, stands up a local
websocket server). Different mechanism, different fix, filed as its own task. Do
not touch it.

## Definition of done

- **Sabotage, and report it:** change `InMemoryIuLedger` so the op scans all
  context buckets instead of indexing the target one; confirm the rewritten test
  fails; restore. Quote the observed failure text. If the test still passes while
  the ledger scans every bucket, your instrument does not discriminate and the
  task is not done.
- `pnpm -C packages/core test` — **415 passing** before your change; zero
  failures after.
- `pnpm -r typecheck` exits 0.
- Run `pnpm -r test` **three consecutive times**; report the exit code of each.
  If a *different* package flakes (deepgram is known to), say which and do not
  claim it as your own failure.

## Constraints

- Do not run any live smoke (`smoke:*`). They cost credits; the manager runs them.
- Do not change `InMemoryIuLedger`'s behaviour — only the test's instrument. The
  sabotage step edits it temporarily and must restore it exactly.
- Do not touch `examples/` or `packages/realtime`.

## DISCLOSURE REQUIREMENT

If you change behaviour this brief did not ask for, or add something you cannot
cover with a test, say so under `undisclosed_changes`. A silent untested
adaptation is a failed dispatch even with a green suite.

## Result contract

Write `runs/result-iuledger-flake.json`:

```json
{
  "task": "Replace the iu-ledger O(1) timing test with a deterministic instrument",
  "status": "done | blocked",
  "claims": [{"cmd": "<command>", "exit": 0, "note": "<what it proves>"}],
  "files_touched": ["..."],
  "instrument": "<what replaced the timing comparison, and why it cannot flake>",
  "sibling_sweep": {
    "voice-agent-session.test.ts": "<compares durations? fixed / left alone + why>",
    "interaction-policy.test.ts": "<same>",
    "vap-policy.test.ts": "<same>"
  },
  "sabotage": "<what you broke, the failure text, that you restored it>",
  "undisclosed_changes": "<anything beyond the brief, or 'none'>"
}
```

Then write `done` to `runs/result-iuledger-flake.done`.
