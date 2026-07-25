// SPDX-License-Identifier: MIT
//
// Bin entry point. The shebang is injected by the esbuild banner at build
// time (see scripts/build.mjs) so the raw TypeScript source stays a plain
// module (mirrors packages/cli/src/index.ts).

import { main } from "./cli.js";

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  });
