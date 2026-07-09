// SPDX-License-Identifier: MIT

import type { PipelineBus } from "../pipeline-bus.js";
import type { InteractionDecision, InteractionObservation, InteractionPolicy } from "../interaction-policy.js";
import { PrimarySpeakerGate } from "../primary-speaker-gate.js";
import { TtsPlayoutClock } from "../tts-playout-clock.js";
import { TurnArbiter } from "../turn-arbiter.js";

export interface RuleBasedInteractionPolicyDeps {
  readonly bus: PipelineBus;
  readonly primarySpeakerGate: PrimarySpeakerGate;
  readonly ttsPlayout: TtsPlayoutClock;
  readonly minInterruptionMs: number;
}

export class RuleBasedInteractionPolicy implements InteractionPolicy {
  readonly arbiter: TurnArbiter;
  private pending: InteractionDecision[] = [];
  private bargeInAudioConsumed = false;

  constructor(deps: RuleBasedInteractionPolicyDeps) {
    this.arbiter = new TurnArbiter({
      ...deps,
      onInterrupt: (id) => this.pending.push({ kind: "interrupt", interruptedContextId: id }),
    });
  }

  observe(obs: InteractionObservation): readonly InteractionDecision[] {
    switch (obs.kind) {
      case "vad_speech_started":
        this.arbiter.onSpeechStarted(
          {
            kind: "vad.speech_started",
            contextId: obs.contextId,
            timestampMs: obs.timestampMs,
            confidence: obs.confidence,
          },
          obs.interruptedContextId,
        );
        break;
      case "vad_speech_activity":
        this.arbiter.onSpeechActivity({
          kind: "vad.speech_activity",
          contextId: obs.contextId,
          timestampMs: obs.timestampMs,
          isAsync: true,
        });
        break;
      case "vad_speech_ended":
        this.arbiter.onSpeechEnded(
          {
            kind: "vad.speech_ended",
            contextId: obs.contextId,
            timestampMs: obs.timestampMs,
          },
          obs.hasActiveTts,
        );
        break;
      case "vad_barge_in_audio":
        this.bargeInAudioConsumed = this.arbiter.observeBargeInAudio({
          kind: "vad.audio",
          contextId: obs.contextId,
          timestampMs: obs.timestampMs,
          audio: obs.audio,
        });
        break;
      case "stt_partial":
        this.arbiter.noteInterimEvidence(obs.text);
        if (obs.interruptedContextId) {
          this.arbiter.onProviderSttEvidence(obs.contextId, obs.timestampMs, obs.interruptedContextId);
        }
        break;
      case "stt_final":
        this.arbiter.noteInterimEvidence(obs.text, obs.confidence);
        if (obs.interruptedContextId) {
          this.arbiter.onProviderSttEvidence(obs.contextId, obs.timestampMs, obs.interruptedContextId);
        }
        break;
      default:
        break;
    }
    if (this.pending.length === 0) return [];
    const out = this.pending;
    this.pending = [];
    return out;
  }

  reset(_contextId: string): void {
    this.arbiter.clear();
  }

  takeBargeInAudioConsumed(): boolean {
    const consumed = this.bargeInAudioConsumed;
    this.bargeInAudioConsumed = false;
    return consumed;
  }
}