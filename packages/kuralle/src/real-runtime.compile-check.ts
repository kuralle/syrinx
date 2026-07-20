// SPDX-License-Identifier: MIT
//
// Compile-only proof that the REAL `@kuralle-agents/core` Runtime satisfies the
// structural `KuralleRuntimeLike` this bridge consumes. Type-checked by
// `tsc --noEmit`; never executed.
//
// Why this file exists: the bridge deliberately types against a structural interface
// rather than importing kuralle's types, so a consumer can supply any runtime-shaped
// object. The cost of that freedom is that nothing was verifying the real Runtime
// still fits — the package pinned `^0.8.5` in devDeps while npm shipped 0.13.0, five
// minors and a package-folder rename later, and no check would have failed. If kuralle
// changes `run` / `getSession` / `getSessionStore`, this file stops compiling.
//
// Mirrors the same pattern as `packages/cf-agents/src/real-agent.compile-check.ts`.

import { Runtime } from "@kuralle-agents/core";
import { fromKuralleRuntime, type KuralleRuntimeLike } from "./from-kuralle.js";

// The three surfaces the bridge actually calls. If the real Runtime drifts from any
// of them, this assignment fails to type-check.
declare const realRuntime: Runtime;
const asBridgeRuntime: KuralleRuntimeLike = realRuntime;

// And the real thing composes into the seam the voice pipeline consumes.
export const reasonerFromRealRuntime = fromKuralleRuntime(asBridgeRuntime, {
  sessionId: "compile-check-session",
});
