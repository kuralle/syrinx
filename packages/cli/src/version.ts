// SPDX-License-Identifier: MIT
//
// Version-skew check (LDT-20 decision #2). On start, resolve the *project's*
// installed @kuralle-syrinx/core from the nearest node_modules relative to cwd —
// not the CLI's own bundled version. If the major differs from the CLI's own
// major, warn loudly to stderr (never stdout — stdout must stay parseable) and
// keep going. Warn; do not refuse.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";

import cliPackageJson from "../package.json" with { type: "json" };

export const CLI_VERSION: string = cliPackageJson.version;
export const CORE_PACKAGE_NAME = "@kuralle-syrinx/core";

export interface ResolvedPackageVersion {
  readonly version: string;
  readonly packageJsonPath: string;
}

/** First path component of a semver string, e.g. "4.3.0" -> "4". Not validated against full semver — good enough for a major-version skew check. */
export function majorOf(version: string): string {
  return version.split(".")[0] ?? version;
}

/**
 * Resolve `pkgName`'s installed version by walking node_modules resolution from
 * `fromDir` (normally the invoking project's cwd), then walking up from the
 * resolved entry file to the package's own package.json. Returns undefined when
 * the package cannot be resolved at all (not installed in this project).
 */
export function resolveInstalledPackageVersion(pkgName: string, fromDir: string): ResolvedPackageVersion | undefined {
  const anchor = join(resolvePath(fromDir), "package.json");
  const require = createRequire(anchor);

  let entryPath: string;
  try {
    entryPath = require.resolve(pkgName);
  } catch {
    return undefined;
  }

  let dir = dirname(entryPath);
  for (let depth = 0; depth < 20; depth += 1) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { name?: unknown; version?: unknown };
        if (parsed.name === pkgName && typeof parsed.version === "string") {
          return { version: parsed.version, packageJsonPath: candidate };
        }
      } catch {
        // Malformed package.json on the walk — keep climbing.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export interface VersionSkewCheck {
  readonly cliVersion: string;
  readonly coreVersion: string | undefined;
  readonly coreResolved: boolean;
  readonly mismatch: boolean;
}

export function checkCoreVersionSkew(fromDir: string): VersionSkewCheck {
  const resolved = resolveInstalledPackageVersion(CORE_PACKAGE_NAME, fromDir);
  if (!resolved) {
    return { cliVersion: CLI_VERSION, coreVersion: undefined, coreResolved: false, mismatch: false };
  }
  const mismatch = majorOf(resolved.version) !== majorOf(CLI_VERSION);
  return { cliVersion: CLI_VERSION, coreVersion: resolved.version, coreResolved: true, mismatch };
}

/** Prints a loud warning to stderr when the CLI's major and the project's installed core major differ. Never writes to stdout. */
export function warnOnVersionSkew(fromDir: string): VersionSkewCheck {
  const check = checkCoreVersionSkew(fromDir);
  if (check.mismatch) {
    console.error(
      `[syrinx] warning: CLI version ${check.cliVersion} (major ${majorOf(check.cliVersion)}) does not match ` +
        `the installed ${CORE_PACKAGE_NAME} version ${String(check.coreVersion)} (major ${majorOf(check.coreVersion ?? "")}) ` +
        `in ${fromDir}. Behavior may differ from what this CLI version expects.`,
    );
  }
  return check;
}
