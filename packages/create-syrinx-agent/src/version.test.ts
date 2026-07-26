// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

describe("GENERATOR_VERSION", () => {
  it("matches package.json — scaffolded projects pin against it", async () => {
    // It drifted once: a lockstep version bump touched package.json and left this
    // literal behind, so every generated project pinned an already-stale floor.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version: string };
    const { GENERATOR_VERSION } = await import("./version.js");
    expect(GENERATOR_VERSION).toBe(pkg.version);
  });
});
