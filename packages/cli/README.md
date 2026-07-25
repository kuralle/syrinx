# @kuralle-syrinx/cli

The agent-facing CLI for a Syrinx voice agent. A coding agent cannot verify its
own work on a voice agent by ear — there is no deterministic, machine-readable
way to run a turn or a text exchange. The [Studio](../../apps/studio) is for
the human (ears, barge-in feel, warmth); this CLI is for a coding agent
(fixtures, text, exit codes).

**This is not a console.** No REPL, no chat loop, no microphone. If a check
needs ears, run it in the Studio instead — this CLI refuses rather than
approximating.

**This CLI brings no providers of its own.** It does not depend on Deepgram,
Cartesia, OpenAI, or any STT/TTS/reasoner SDK — a global `npm install -g
@kuralle-syrinx/cli` does not download a single provider package. Every
provider-touching command takes `--agent <module>#<export>`, pointing the CLI
at *your* code; your module brings its own providers.

## Install

```
npm install -g @kuralle-syrinx/cli
```

Installs a `syrinx` binary — a single self-contained, built JavaScript file
(no `ts-node`/`tsx` required to run it).

## `--agent` (required for `turn` and `text`)

```
--agent <module>[#namedExport]
```

`<module>` is a path to your own code (resolved relative to cwd unless
absolute); the export must be a zero-arg factory returning a
`VoiceAgentSession` — or a `Promise` of one — the same contract
[`examples/02-hello-voice-headless/scripts/dev-server.ts`](../../examples/02-hello-voice-headless/scripts/dev-server.ts)'s
own `--agent` flag already uses (not a second convention). Omit `#export` for
a default export (or a `createSession` export, checked in that order).

```ts
// my-agent.ts
import { VoiceAgentSession } from "@kuralle-syrinx/core";
import { DeepgramSTTPlugin } from "@kuralle-syrinx/deepgram";
// ...your own providers...

export default function createSession() {
  const session = new VoiceAgentSession({ plugins: { /* ... */ } });
  session.registerPlugin("stt", new DeepgramSTTPlugin());
  // ...
  return session;
}
```

Resolution failures are loud and specific, never a silent fallback:
- Module not found, or the named export doesn't exist / isn't callable →
  `USAGE`, naming the callable exports that *were* found.
- The export resolves and is callable but **throws when invoked** → `CONFIG`
  — most plausibly your module is missing something it needs (an env var, a
  key file, ...).

## Commands

### `syrinx turn --in <fixture.wav|fixture.json> --agent <module>#<export> [options]`

Run one turn through the resolved agent and report the transcript, the reply,
and per-stage timings.

Given a `fixture.json` sidecar produced by the Studio's "Save as fixture"
(format `syrinx.fixture.v1`, paired with the WAV it captured), the command
honours the sidecar's recorded capture config and **refuses** — a `USAGE`
exit, not a silently-wrong replay — when it cannot honestly satisfy it (an
unrecognised fixture format, or audio that isn't mono 16 kHz). When the
sidecar carries an `expectedTranscript`, the replayed transcript is asserted
against it; a mismatch is an `ASSERTION` exit, not a passing run.

```
syrinx turn --in ./captured.json --agent ./my-agent.ts --json
syrinx turn --in ./hello.wav --agent ./my-agent.ts#createSession
```

### `syrinx text "<message>" --agent <module>#<export>`

Send a typed turn (no STT, no microphone) to the resolved agent and report the
reply — pushes the same `user.text_received` packet a real typed turn would.

```
syrinx text "What's the cancellation policy?" --agent ./my-agent.ts --json
```

### `syrinx doctor [--agent <module>#<export>]`

Reports the Node runtime and whether `@kuralle-syrinx/core` is installed in
the current project and which version. Also reports, informationally only,
which well-known provider keys (`DEEPGRAM_API_KEY`, `OPENAI_API_KEY`, ...) are
present in the environment (**never** their values) — this CLI does not
require any specific one; whatever `--agent` resolves to owns its own
requirements. Pass `--agent` to check whether a *specific* agent module
resolves, without invoking it. Always exits `SUCCESS` — this command
diagnoses, it does not assert.

```
syrinx doctor --json
syrinx doctor --agent ./my-agent.ts --json
```

## `--json`

`--json` is a first-class output mode on every command, not a side flag: it
emits exactly one parseable JSON object on stdout, `{ ok, verb, ... }` on
success or `{ ok: false, verb, error: { code, message, ... } }` on failure.
Diagnostics — currently just the version-skew warning below — always go to
stderr, never stdout, so `--json` output stays parseable no matter what.
Without `--json`, commands print a short human-readable summary to stdout and
errors to stderr.

## Version skew

On start, the CLI resolves the invoking project's installed
`@kuralle-syrinx/core` from the nearest `node_modules` (not its own bundled
version). If the major version differs from the CLI's own major, it prints a
warning naming both versions to stderr and keeps going — it warns, it does not
refuse.

## Exit codes

| Code | Name | Meaning |
| --- | --- | --- |
| 0 | `SUCCESS` | the command completed and, where applicable, any assertion matched |
| 1 | `INTERNAL` | an unexpected error inside the CLI itself — treat as a bug |
| 2 | `USAGE` | bad invocation: unknown verb/flag, a missing required argument, a `--agent` that could not be resolved, or a fixture the CLI cannot honour |
| 3 | `CONFIG` | the resolved `--agent` module threw constructing a session — most plausibly its own missing configuration |
| 4 | `BACKEND` | the agent or backend failed while running the turn (provider/network error, timeout, pipeline error) |
| 5 | `ASSERTION` | a replayed fixture's transcript drifted from the expected transcript |

The same table is printed by `syrinx --help`.

## Reuse, not reimplementation

`packages/cli/src/turn-runner.ts` owns exactly one thing: feeding audio into
an already-built `VoiceAgentSession` and capturing the transcript/reply/
timings/artifacts (`driveTurn`) — it never constructs a provider. Two callers
share it:
- The CLI's own `turn` command, via the `--agent` seam above.
- `examples/02-hello-voice-headless/src/run-one-turn.ts`'s `runOneTurn`, which
  keeps its own hardcoded Deepgram+OpenAI+Cartesia+Silero default kernel
  (legitimate there — it's a demo harness, not a shipped package) and
  delegates the actual turn-driving mechanics to `driveTurn` here, imported
  as `@kuralle-syrinx/cli/turn-runner`.

There is exactly one implementation of "drive a turn"; only the (necessarily
different) provider wiring differs between the two callers.
