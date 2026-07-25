// SPDX-License-Identifier: MIT
//
// Generated project's tsconfig.json — mirrors examples/02-hello-voice-headless/tsconfig.json.
// --runtime cloudflare additionally needs @cloudflare/workers-types: src/index.ts's
// `Request`/`Response`/`fetch` globals come from there, not from a DOM lib (this
// tsconfig has no "DOM" in `lib`, matching the node-runtime file it sits beside).

import type { Runtime } from "../options.js";

export function buildTsconfig(runtime: Runtime): string {
  const types = runtime === "cloudflare" ? ["node", "@cloudflare/workers-types"] : ["node"];
  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      types,
    },
    include: ["src/**/*.ts", "scripts/**/*.ts"],
  };
  return `${JSON.stringify(tsconfig, null, 2)}\n`;
}
