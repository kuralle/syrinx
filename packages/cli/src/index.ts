// SPDX-License-Identifier: MIT
//
// Bin entry point. The shebang is injected by the esbuild banner at build time
// (see scripts/build.mjs) so the raw TypeScript source stays a plain module.

import { main } from "./cli.js";
import { CliError, EXIT_CODES } from "./exit-codes.js";

/**
 * Report a failure the way the contract promises: one line on stderr, the
 * documented code on exit. Never a stack trace — stdout may already hold a
 * `--json` object, and a stack after it corrupts what a caller parses.
 * A stack is only useful for an unexpected internal fault, which is what
 * INTERNAL means.
 */
function fail(err: unknown): number {
  if (err instanceof CliError) {
    console.error(err.message);
    return err.exitCode;
  }
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  return EXIT_CODES.INTERNAL;
}

// A rejection that escapes the command — e.g. a listener that settles after the
// command already returned — must not print a stack over a written JSON object.
process.on("unhandledRejection", (reason) => {
  process.exitCode = fail(reason);
});

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.exitCode = fail(err);
  });
