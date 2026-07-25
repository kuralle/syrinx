// SPDX-License-Identifier: MIT
//
// Bundles src/index.ts into a single self-contained dist/index.js the "bin"
// field points at, so `create-syrinx-agent` runs with plain node — no
// ts-node/tsx, no raw TS shipped as the executable (mirrors packages/cli's
// scripts/build.mjs). This generator has no runtime dependencies of its own
// (every generated file is a template string built at generation time), so
// there is nothing to externalize.
import { build } from "esbuild";
import { chmod } from "node:fs/promises";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "info",
});

await chmod("dist/index.js", 0o755);
