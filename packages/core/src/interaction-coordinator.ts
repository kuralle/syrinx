// SPDX-License-Identifier: MIT

import type { VadAudioPacket } from "./packets.js";
import type { PipelineBus } from "./pipeline-bus.js";
import type { InteractionDecision, InteractionObservation, InteractionPolicy } from "./interaction-policy.js";
import type { TurnArbiter } from "./turn-arbiter.js";
import { RuleBasedInteractionPolicy } from "./policies/rule-based.js";

export class InteractionCoordinator {
  constructor(
    private readonly deps: {
      bus: PipelineBus;
      policy: InteractionPolicy;
      executor: TurnArbiter;
    },
  ) {}

  observe(obs: InteractionObservation): void {
    for (const d of this.deps.policy.observe(obs)) {
      this.apply(d);
    }
  }

  observeBargeInAudio(pkt: VadAudioPacket): boolean {
    this.observe({
      kind: "vad_barge_in_audio",
      contextId: pkt.contextId,
      timestampMs: pkt.timestampMs,
      audio: pkt.audio,
    });
    if (this.deps.policy instanceof RuleBasedInteractionPolicy) {
      return this.deps.policy.takeBargeInAudioConsumed();
    }
    return this.deps.executor.observeBargeInAudio(pkt);
  }

  private apply(d: InteractionDecision): void {
    switch (d.kind) {
      case "interrupt":
        this.deps.executor.emitInterruptDetected(d.interruptedContextId);
        break;
      default:
        break;
    }
  }

  reset(contextId: string): void {
    this.deps.policy.reset(contextId);
  }
}