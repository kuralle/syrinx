// SPDX-License-Identifier: MIT

import type { VadAudioPacket } from "./packets.js";
import { Route } from "./pipeline-bus.js";
import type { PipelineBus } from "./pipeline-bus.js";
import type { InteractionDecision, InteractionObservation, InteractionPolicy } from "./interaction-policy.js";
import type { TurnArbiter } from "./turn-arbiter.js";
import { RuleBasedInteractionPolicy } from "./policies/rule-based.js";
import * as make from "./packet-factories.js";

export interface InteractionCaps {
  readonly emitsBackchannel?: boolean;
}

export class InteractionCoordinator {
  constructor(
    private readonly deps: {
      bus: PipelineBus;
      policy: InteractionPolicy;
      executor: TurnArbiter;
      caps: InteractionCaps;
      isUserSpeaking?: () => boolean;
      isTtsActive?: () => boolean;
      hasCueAsset?: (cueId: string) => boolean;
      onBackchannelEmitted?: (contextId: string) => void;
    },
  ) {}

  observe(obs: InteractionObservation): void {
    for (const d of this.deps.policy.observe(obs)) {
      this.apply(d, obs);
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

  private apply(d: InteractionDecision, obs: InteractionObservation): void {
    switch (d.kind) {
      case "interrupt":
        this.deps.executor.emitInterruptDetected(d.interruptedContextId);
        break;
      case "backchannel":
        this.applyBackchannel(d, obs);
        break;
      default:
        break;
    }
  }

  private applyBackchannel(
    d: Extract<InteractionDecision, { kind: "backchannel" }>,
    obs: InteractionObservation,
  ): void {
    const contextId = obs.contextId;
    this.deps.bus.push(Route.Background, make.metric(contextId, "backchannel.candidate", d.cue));

    if (this.deps.caps.emitsBackchannel) {
      this.deps.bus.push(Route.Background, make.metric(contextId, "backchannel.suppressed_caps", d.cue));
      return;
    }
    if (this.deps.isTtsActive?.()) {
      this.deps.bus.push(Route.Background, make.metric(contextId, "backchannel.suppressed_tts_active", d.cue));
      return;
    }
    if (this.deps.isUserSpeaking?.()) {
      this.deps.bus.push(Route.Background, make.metric(contextId, "backchannel.suppressed_user_speaking", d.cue));
      return;
    }
    if (this.deps.hasCueAsset && !this.deps.hasCueAsset(d.cue)) {
      this.deps.bus.push(Route.Background, make.metric(contextId, "backchannel.suppressed_missing_asset", d.cue));
      return;
    }

    this.deps.bus.push(Route.Main, make.interactionBackchannel(contextId, Date.now(), d.cue));
    this.deps.bus.push(Route.Background, make.metric(contextId, "backchannel.emitted", d.cue));
    this.deps.onBackchannelEmitted?.(contextId);
  }

  reset(contextId: string): void {
    this.deps.policy.reset(contextId);
  }
}