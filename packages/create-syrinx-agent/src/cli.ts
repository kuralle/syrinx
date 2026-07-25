// SPDX-License-Identifier: MIT
//
// Argument parsing and dispatch. Never interactive beyond what --yes/TTY
// rules allow: no spinners, no colour. Results go to stdout, diagnostics to
// stderr.

import { parseArgs } from "node:util";

import { CliError, EXIT_CODES, type ExitCode } from "./exit-codes.js";
import { HELP_TEXT } from "./help.js";
import { GENERATOR_VERSION } from "./version.js";
import { runGenerate } from "./generate.js";

export interface CliIO {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

export const defaultIO: CliIO = {
  stdout: (line) => {
    process.stdout.write(`${line}\n`);
  },
  stderr: (line) => {
    process.stderr.write(`${line}\n`);
  },
};

const PARSE_OPTIONS = {
  "help": { type: "boolean", short: "h" },
  "version": { type: "boolean", short: "v" },
  "stt": { type: "string" },
  "tts": { type: "string" },
  "realtime": { type: "string" },
  "reasoner": { type: "string" },
  "vad": { type: "string" },
  "endpointing": { type: "string" },
  "transport": { type: "string" },
  "runtime": { type: "string" },
  "preset": { type: "string" },
  "name": { type: "string" },
  "yes": { type: "boolean" },
  "no-install": { type: "boolean" },
  "skip-install": { type: "boolean" },
  "dry-run": { type: "boolean" },
} as const;

export async function main(argv: readonly string[], io: CliIO = defaultIO): Promise<ExitCode> {
  if (argv.includes("--help") || argv.includes("-h")) {
    io.stdout(HELP_TEXT);
    return EXIT_CODES.SUCCESS;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    io.stdout(GENERATOR_VERSION);
    return EXIT_CODES.SUCCESS;
  }

  let parsed: ReturnType<typeof parseArgs<{ options: typeof PARSE_OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: [...argv], options: PARSE_OPTIONS, allowPositionals: true });
  } catch (err) {
    io.stderr(err instanceof Error ? err.message : String(err));
    return EXIT_CODES.USAGE;
  }

  try {
    await runGenerate(parsed.values, parsed.positionals, io);
    return EXIT_CODES.SUCCESS;
  } catch (err) {
    if (err instanceof CliError) {
      io.stderr(err.message);
      return err.exitCode;
    }
    io.stderr(err instanceof Error ? (err.stack ?? err.message) : String(err));
    return EXIT_CODES.INTERNAL;
  }
}
