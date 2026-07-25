// SPDX-License-Identifier: MIT
//
// Bundles src/index.ts into a single self-contained dist/index.js the "bin"
// field points at, so `syrinx` runs with plain node — no ts-node/tsx, no raw
// TS shipped as the executable (LDT-20 decision #1). The only workspace
// dependency this CLI has is @kuralle-syrinx/core, which ships raw TypeScript
// as its "main"; bundling is what turns that into runnable JS here.
//
// This CLI has no provider dependencies (Deepgram/Cartesia/OpenAI/silero-vad/
// ...) — see agent-resolve.ts's --agent seam — so there is no native addon to
// externalize and no CJS-in-ESM interop workaround needed. If a future
// dependency reintroduces one, mark it `external` here and say why, rather
// than adding a package to `dependencies` purely to satisfy the bundler.
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
