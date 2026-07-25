# Brief — LDT-20: the agent-facing CLI

Repo root is your worktree. Work on the current branch. **Commit nothing.**

## Why this exists

A coding agent cannot verify its own work on a voice agent. There is no deterministic,
machine-readable way to run a turn or a text exchange. The Studio is for the human (ears,
barge-in feel, warmth); this CLI is for a coding agent (fixtures, text, exit codes).

That split is the whole design. **This is not a console.** No REPL, no chat loop, no
microphone. If a check needs ears, the CLI says so and stops rather than approximating.

## The two decisions that were blocking this — MADE, do not re-open

**1. Packaging: a real built package with a `bin`.**
Create `packages/cli` as `@kuralle-syrinx/cli`, `"bin": { "syrinx": "./dist/index.js" }`,
built with the same toolchain its siblings use — read `packages/browser-client/package.json`
and `packages/server-websocket/package.json` and match them. **Not** a raw-TS entry and
**not** a `tsx` shim: shipping raw TS has already bitten this repo.

**2. Version skew: prefer the locally-installed binary; warn loudly on a major mismatch.**
On start, resolve the project's `@kuralle-syrinx/core` version from the nearest
`node_modules`. If the CLI's own major differs, print a clear warning to **stderr** (never
stdout — stdout must stay parseable) naming both versions. Warn; do not refuse.

## Verbs — exactly these

- `syrinx turn --in <fixture.wav|fixture.json>` — run one turn through an agent, report
  the transcript, the reply, and per-stage timings. Accept a fixture pair produced by the
  Studio's "Save as fixture" (`syrinx.fixture.v1`); when given the `.json`, honour its
  recorded capture config and **refuse** on a mismatch it cannot satisfy rather than
  replaying under conditions that silently change the answer.
- `syrinx text "<message>"` — send a typed turn, report the reply. No STT, no microphone.
- `syrinx doctor` — report what is configured and what is missing: which provider keys are
  present (never print their values), which runtime, whether a backend is reachable.

Explicitly NOT: `console`, `chat`, `listen`, or anything interactive.

## The contract an agent depends on

- **`--json` is a first-class output mode, not a side flag.** Prose is unusable to an
  agent. Every verb supports it and emits a single parseable object on stdout. Human
  output goes to stdout too, but never interleaved with JSON — pick one per run.
- **Diagnostics on stderr, results on stdout.** Always. A warning must never corrupt
  `--json` output.
- **Exit codes are the contract.** Distinct codes per failure class, documented in
  `--help` and in the package README. At minimum: success; bad usage; missing
  configuration/keys; the agent or backend failed; the assertion failed (e.g. a replayed
  fixture's transcript drifted). Do not collapse these into 1.
- **Never interactive.** No prompts, no spinners that assume a TTY, no colour unless the
  stream is a TTY.

## Reuse, do not reimplement

`examples/02-hello-voice-headless/src/run-one-turn.ts` already runs a turn end to end and
returns transcript, reply and per-turn metrics. `scripts/replay-fixture.ts` in that same
package already reads the `syrinx.fixture.v1` sidecar and compares transcripts. Read both
first. If the logic belongs in the CLI, move it somewhere shared rather than copying it —
two implementations of one turn-runner will drift.

## Hard requirements

- Root-cause fixes only. No `@ts-ignore`, no `as any`.
- No new runtime dependencies without saying why in your report. Prefer `node:util`'s
  `parseArgs` over an argument-parsing library.
- Do not modify `apps/studio/`, `apps/docs/`, or anything telephony.
- Match the repo's existing style — read a sibling package before writing.

## Gate — all must exit 0

```
pnpm -C packages/cli typecheck
pnpm -C packages/cli test
pnpm -C packages/cli build
pnpm -r typecheck
```

Then **actually run the built binary** and paste the real output in your report:
```
node packages/cli/dist/index.js doctor --json
node packages/cli/dist/index.js --help
```
A CLI that typechecks but was never executed is not verified. If you cannot run `turn`
because provider keys are absent in your environment, say so plainly — `doctor` and
`--help` must still run, and `turn` must fail with the documented missing-config exit
code rather than a stack trace.

## Command efficiency

NEVER re-run an expensive command just to reshape its output. Run it ONCE into a
`mktemp` file (`log=$(mktemp); cmd > "$log" 2>&1`), then grep that file.

## Report back, as your final text

1. The absolute worktree path.
2. Files created/changed, one line each.
3. The exit-code table you settled on.
4. **Verbatim output** of the two binary invocations above.
5. Every command you ran with its actual exit code. Do not list one you did not run.
6. Anything you could not verify, and what would prove it.

Your final text is the return value, not a message to a human. Terse and factual.
