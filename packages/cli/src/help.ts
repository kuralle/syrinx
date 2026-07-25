// SPDX-License-Identifier: MIT

import { EXIT_CODE_TABLE } from "./exit-codes.js";

const EXIT_CODE_LINES = EXIT_CODE_TABLE.map((row) => `  ${String(row.code)}  ${row.name.padEnd(9)} ${row.meaning}`).join("\n");

export const HELP_TEXT = `syrinx — the agent-facing CLI for a Syrinx voice agent.

Not a console: no REPL, no chat loop, no microphone. Every command is a single
deterministic invocation with a documented exit code, meant to be run by a
coding agent (or a script), not a human at a prompt.

This CLI brings no providers of its own — no Deepgram, no Cartesia, no OpenAI.
--agent points it at YOUR agent module; that module owns its own providers.

USAGE
  syrinx <command> [options]

AGENT RESOLUTION (--agent, required for turn and text)
  --agent <module>[#namedExport]
      <module> is a path (resolved relative to cwd unless absolute) to your
      own code; the export must be a zero-arg factory returning a
      VoiceAgentSession (or a Promise of one) — exactly the contract
      examples/02-hello-voice-headless/scripts/dev-server.ts's --agent flag
      uses. Omit #export for a default export (or a "createSession" export).
      Resolution failures (module not found, no such export, export not
      callable) exit USAGE and name the callable exports that were found.
      If the export IS callable but throws when invoked, that exits CONFIG —
      most plausibly the agent's own module is missing something it needs
      (an env var, a key file, ...).

COMMANDS
  turn --in <fixture.wav|fixture.json> --agent <module>#<export> [options]
      Run one turn through the resolved agent and report the transcript, the
      reply, and per-stage timings. Given a fixture.json sidecar (produced by
      the Studio's "Save as fixture"), honours its recorded capture config
      and, when the sidecar carries an expected transcript, asserts the
      replay matches it.
    --in <path>              required. fixture.wav or fixture.json
    --agent <module>#<export>  required.
    --session-dir <dir>       where turn artifacts are written (default: a temp dir)
    --json                    emit one parseable JSON object on stdout

  text "<message>" --agent <module>#<export> [options]
      Send a typed turn (no STT, no microphone) to the resolved agent and
      report the reply.
    --agent <module>#<export>  required.
    --json                    emit one parseable JSON object on stdout

  doctor [--agent <module>#<export>] [--json]
      Report what is configured: the Node runtime, whether
      @kuralle-syrinx/core is installed and its version, and — informational
      only — which well-known provider keys are present in the environment
      (never their values). This CLI does not require any specific provider
      key; pass --agent to check whether a SPECIFIC agent module resolves.
      Always exits 0 — this command diagnoses, it does not assert.

  --help, -h                show this help
  --version, -v              print the CLI version

OUTPUT
  --json is a first-class output mode: every command supports it and emits a
  single parseable JSON object on stdout. Diagnostics (warnings, e.g. a
  version-skew notice) always go to stderr, never stdout, so --json output
  stays parseable. Without --json, commands print a short human-readable
  summary to stdout and errors to stderr.

EXIT CODES
${EXIT_CODE_LINES}
`;
