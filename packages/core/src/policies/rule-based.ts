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
  /** When true, the underlying TurnArbiter emits duck/resume signals during barge-in evaluation. */
  readonly pauseThenResolveBargeIn?: boolean;
  /** Tenant-level backchannel knobs. Default (undefined) = current behavior (`mm_hmm`). */
  readonly backchannel?: {
    readonly enabled?: boolean;
    readonly cues?: readonly string[];
  };
}

export class RuleBasedInteractionPolicy implements InteractionPolicy {
  readonly arbiter: TurnArbiter;
  private readonly ttsPlayout: TtsPlayoutClock;
  private readonly backchannelConfig: RuleBasedInteractionPolicyDeps["backchannel"];
  private pending: InteractionDecision[] = [];
  private bargeInAudioConsumed = false;
  private delegateGapOpen = false;
  private delegateCuePlayed = false;
  private userSpeaking = false;

  constructor(deps: RuleBasedInteractionPolicyDeps) {
    this.ttsPlayout = deps.ttsPlayout;
    this.backchannelConfig = deps.backchannel;
    this.arbiter = new TurnArbiter({
      bus: deps.bus,
      primarySpeakerGate: deps.primarySpeakerGate,
      ttsPlayout: deps.ttsPlayout,
      minInterruptionMs: deps.minInterruptionMs,
      pauseThenResolveBargeIn: deps.pauseThenResolveBargeIn,
      onInterrupt: (id) => this.pending.push({ kind: "interrupt", interruptedContextId: id }),
    });
  }

  observe(obs: InteractionObservation): readonly InteractionDecision[] {
    switch (obs.kind) {
      case "vad_speech_started":
        this.userSpeaking = true;
        if (obs.interruptedContextId) this.arbiter.onSpeechStarted(
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
        this.userSpeaking = false;
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
      case "delegate_state":
        this.pending.push(...this.handleDelegateState(obs));
        break;
      default:
        break;
    }
    if (this.pending.length === 0) return [];
    const out = this.pending;
    this.pending = [];
    return out;
  }

  private handleDelegateState(obs: InteractionObservation & { kind: "delegate_state" }): InteractionDecision[] {
    const phase = obs.toolCallPhase;
    if (!phase) return [];

    switch (phase) {
      case "started":
        this.delegateGapOpen = true;
        this.delegateCuePlayed = false;
        return [];
      case "delayed": {
        if (!this.delegateGapOpen || this.delegateCuePlayed) return [];
        if (this.depsTtsActive()) return [];
        if (this.userSpeaking) return [];
        this.delegateCuePlayed = true;
        if (this.backchannelConfig?.enabled === false) return [];
        const cue = this.backchannelConfig?.cues?.[0] ?? "mm_hmm";
        return [{ kind: "backchannel", cue }];
      }
      case "complete":
      case "failed":
        this.delegateGapOpen = false;
        this.delegateCuePlayed = false;
        return [];
      default:
        return [];
    }
  }

  private depsTtsActive(): boolean {
    return this.ttsPlayout.activeContexts().length > 0;
  }

  reset(_contextId: string): void {
    this.delegateGapOpen = false;
    this.delegateCuePlayed = false;
    this.userSpeaking = false;
    this.arbiter.clear();
  }

  takeBargeInAudioConsumed(): boolean {
    const consumed = this.bargeInAudioConsumed;
    this.bargeInAudioConsumed = false;
    return consumed;
  }
}
