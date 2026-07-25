// SPDX-License-Identifier: MIT
//
// The exit-code contract an agent depends on. Every verb resolves to exactly one
// of these — never collapsed to a bare 1 for "something went wrong". Documented
// here once; `--help` and the README quote this table verbatim.

export const EXIT_CODES = {
  SUCCESS: 0,
  INTERNAL: 1,
  USAGE: 2,
  CONFIG: 3,
  BACKEND: 4,
  ASSERTION: 5,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export const EXIT_CODE_TABLE: ReadonlyArray<{ readonly code: ExitCode; readonly name: string; readonly meaning: string }> = [
  { code: EXIT_CODES.SUCCESS, name: "SUCCESS", meaning: "the command completed and, where applicable, any assertion matched" },
  { code: EXIT_CODES.INTERNAL, name: "INTERNAL", meaning: "an unexpected error inside the CLI itself (not a usage or backend problem) — treat as a bug" },
  { code: EXIT_CODES.USAGE, name: "USAGE", meaning: "bad invocation: unknown verb/flag, a missing required argument, or a fixture the CLI cannot honour (unsupported format, capture-config mismatch)" },
  { code: EXIT_CODES.CONFIG, name: "CONFIG", meaning: "required provider configuration or API keys are missing" },
  { code: EXIT_CODES.BACKEND, name: "BACKEND", meaning: "the agent or backend failed while running the turn (provider/network error, timeout, pipeline error)" },
  { code: EXIT_CODES.ASSERTION, name: "ASSERTION", meaning: "a replayed fixture's transcript drifted from the expected transcript" },
];

/** A typed error carrying the exit code it should terminate the process with. */
export class CliError extends Error {
  readonly exitCode: ExitCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(exitCode: ExitCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.details = details;
  }
}
