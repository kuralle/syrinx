// SPDX-License-Identifier: MIT

export const EXIT_CODES = {
  SUCCESS: 0,
  INTERNAL: 1,
  USAGE: 2,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/** A typed error carrying the exit code the process should terminate with. */
export class CliError extends Error {
  readonly exitCode: ExitCode;

  constructor(exitCode: ExitCode, message: string) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}
