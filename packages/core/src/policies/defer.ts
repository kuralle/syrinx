// SPDX-License-Identifier: MIT

import type { InteractionDecision, InteractionObservation, InteractionPolicy } from "../interaction-policy.js";

/**
 * The front owns full-duplex interaction (turn-taking, barge-in, backchannels). This policy takes no
 * action — it observes only, so the coordinator drives nothing and the front's own decisions (surfaced
 * by its adapter/bridge as interrupt.detected / eos.turn_complete) stand. RFC InteractionPolicy REQ-4.
 */
export class DeferInteractionPolicy implements InteractionPolicy {
  observe(_obs: InteractionObservation): readonly InteractionDecision[] {
    return [];
  }
  reset(_contextId: string): void {}
}