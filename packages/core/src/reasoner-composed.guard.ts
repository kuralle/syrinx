// SPDX-License-Identifier: MIT
//
// Compile guard: wrapper reasoners MUST implement every Required<ReasonerCapabilities>
// member. Type-alias assignment — not `as` assertion — so a missing forward fails here.

import type { HedgedReasoner } from "./reasoner-hedge.js";
import type { RoutingReasoner } from "./reasoner-route.js";
import type { ComposedReasoner } from "./reasoner.js";

/** Fails at compile time when T omits a required capability forward. */
export type AssertComposedReasoner<T extends ComposedReasoner> = T;

type _HedgedReasonerIsComposed = AssertComposedReasoner<HedgedReasoner>;
type _RoutingReasonerIsComposed = AssertComposedReasoner<RoutingReasoner>;

/** Runtime hook so vitest exercises the guard module (types are erased at runtime). */
export function assertComposedReasoner(reasoner: ComposedReasoner): ComposedReasoner {
  return reasoner;
}
