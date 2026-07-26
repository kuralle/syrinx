// SPDX-License-Identifier: MIT
//
// Bundles src/index.ts into a single self-contained dist/index.js the "bin"
// field points at, so `syrinx` runs with plain node — no ts-node/tsx, no raw
// TS shipped as the executable (LDT-20 decision #1). Bundling also keeps the bin
// self-contained and fast to start. (It originally existed because core shipped
// raw TypeScript as its "main"; core builds to dist now, so that reason is gone —
// the self-contained bin is why it stays.)
//
// `./turn-runner` is a second entry: it is a LIBRARY subpath the example package
// imports, and it must resolve to JS for the same reason the bin does. Types come
// from tsc --emitDeclarationOnly, since esbuild emits none.
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

await build({
  entryPoints: ["src/turn-runner.ts"],
  outfile: "dist/turn-runner.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  external: ["@kuralle-syrinx/*"],
  logLevel: "info",
});

await chmod("dist/index.js", 0o755);
