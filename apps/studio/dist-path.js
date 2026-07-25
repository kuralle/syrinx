// SPDX-License-Identifier: MIT
//
// Resolving a *directory* inside a package is awkward in ESM — there is no
// `require.resolve` for a folder, and `import.meta.resolve` needs a file. So the
// package exports this tiny module and consumers resolve the folder relative to
// it. That keeps working under pnpm's symlinked store and under hoisting.
//
//   import { studioDistPath } from "@kuralle-syrinx/studio/dist-path";
//   server.use(serveStatic(studioDistPath));

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to the built studio assets (index.html + assets/). */
export const studioDistPath = join(dirname(fileURLToPath(import.meta.url)), "dist");
