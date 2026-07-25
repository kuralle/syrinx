// SPDX-License-Identifier: MIT
//
// Wires flag parsing -> validation -> file generation -> (optional) install.

import { resolveOptions, warningsFor, type RawFlags } from "./options.js";
import { buildFileMap, runNpmInstall, writeProject } from "./write-project.js";
import type { CliIO } from "./cli.js";

export async function runGenerate(values: RawFlags, positionals: readonly string[], io: CliIO): Promise<void> {
  const opts = resolveOptions(values, positionals);

  for (const warning of warningsFor(opts)) {
    io.stderr(`warning: ${warning}`);
  }

  const files = buildFileMap(opts);

  if (opts.dryRun) {
    io.stdout(`Would write ${String(files.length)} file(s) to ${opts.targetDir}:`);
    for (const file of files) io.stdout(`  ${file.relPath}`);
    return;
  }

  await writeProject(opts.targetDir, files);
  io.stdout(`Wrote ${String(files.length)} file(s) to ${opts.targetDir}`);

  if (opts.skipInstall) {
    io.stdout("Skipped install (--no-install). Run `npm install` inside the project next.");
    return;
  }

  io.stdout(`Installing dependencies in ${opts.name}/ ...`);
  runNpmInstall(opts.targetDir);
  io.stdout("Done.");
}
