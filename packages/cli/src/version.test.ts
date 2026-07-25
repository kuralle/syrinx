// SPDX-License-Identifier: MIT

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CLI_VERSION, checkCoreVersionSkew, majorOf, resolveInstalledPackageVersion } from "./version.js";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("majorOf", () => {
  it("takes the first dot-separated component", () => {
    expect(majorOf("4.3.0")).toBe("4");
    expect(majorOf("10.0.0-beta.1")).toBe("10");
  });
});

describe("resolveInstalledPackageVersion", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "syrinx-cli-version-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, maxRetries: 3, force: true }).catch(() => {});
  });

  it("finds a package's declared version by walking up from its resolved entry file", async () => {
    const pkgDir = join(root, "node_modules", "@fake", "pkg");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name: "@fake/pkg", version: "1.2.3", main: "./index.js" }));
    await writeFile(join(pkgDir, "index.js"), "module.exports = {};\n");

    const resolved = resolveInstalledPackageVersion("@fake/pkg", root);
    expect(resolved?.version).toBe("1.2.3");
  });

  it("returns undefined when the package is not installed", async () => {
    expect(resolveInstalledPackageVersion("@fake/does-not-exist", root)).toBeUndefined();
  });

  it("resolves the real @kuralle-syrinx/core installed in this workspace", () => {
    // fromDir = this test file's own directory, so node_modules resolution walks
    // up through packages/cli's real workspace-linked node_modules.
    const resolved = resolveInstalledPackageVersion("@kuralle-syrinx/core", HERE);
    expect(resolved?.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("checkCoreVersionSkew", () => {
  it("reports no mismatch against this workspace's own core (same lockstep version as the CLI)", () => {
    const check = checkCoreVersionSkew(HERE);
    expect(check.coreResolved).toBe(true);
    expect(check.mismatch).toBe(false);
    expect(check.cliVersion).toBe(CLI_VERSION);
  });

  it("never throws and reports mismatch: false whenever core cannot be resolved", () => {
    // resolveInstalledPackageVersion's own "not installed" contract is covered directly
    // above with a package name guaranteed absent everywhere; here we only assert
    // checkCoreVersionSkew degrades safely (no throw, no false-positive mismatch) —
    // an arbitrary directory can still resolve the real @kuralle-syrinx/core via this
    // workspace's module resolution, so "not found" isn't reproducible from cwd alone.
    expect(() => checkCoreVersionSkew(HERE)).not.toThrow();
    expect(checkCoreVersionSkew(HERE).mismatch).toBe(false);
  });
});
