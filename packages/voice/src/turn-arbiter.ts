// SPDX-License-Identifier: MIT
//
// CR-09 — explicit turn-taking state for barge-in decisions (G1 + VE-02).

import { Route, type PipelineBus } from "./pipeline-bus.js";
import type {
  VadAudioPacket,
  VadSpeechActivityPacket,
  VadSpeechEndedPacket,
  VadSpeechStartedPacket,
} from "./packets.js";
import { PrimarySpeakerGate } from "./primary-speaker-gate.js";
import { TtsPlayoutClock } from "./tts-playout-clock.js";
import * as make from "./packet-factories.js";

type TurnInterruptionState =
  | { kind: "idle" }
  | {
      kind: "pending";
      userContextId: string;
      interruptedContextId: string;
      firstSpeechMs: number;
      awaitingAudio: boolean;
    };

type PendingTurnInterruption = Extract<TurnInterruptionState, { kind: "pending" }>;

export interface TurnArbiterDeps {
  readonly bus: PipelineBus;
  readonly primarySpeakerGate: PrimarySpeakerGate;
  readonly ttsPlayout: TtsPlayoutClock;
  readonly minInterruptionMs: number;
}

export class TurnArbiter {
  private turnInterruption: TurnInterruptionState = { kind: "idle" };

  constructor(private readonly deps: TurnArbiterDeps) {}

  onSpeechStarted(pkt: VadSpeechStartedPacket, interruptedContextId: string): void {
    const { minInterruptionMs, bus, primarySpeakerGate } = this.deps;

    if (minInterruptionMs <= 0) {
      if (this.shouldDeferImmediateBargeInForSpeakerGate()) {
        this.transitionToPending(pkt, interruptedContextId, true);
        return;
      }
      bus.push(Route.Background, make.metric(interruptedContextId, "vaqi.interruption", "1"));
      this.emitInterruptDetected(interruptedContextId);
      return;
    }

    this.transitionToPending(pkt, interruptedContextId, false);
  }

  onSpeechActivity(pkt: VadSpeechActivityPacket): void {
    const pending = this.pendingFor(pkt.contextId);
    if (!pending) return;
    if (pkt.timestampMs - pending.firstSpeechMs < this.deps.minInterruptionMs) return;
    this.tryCommit(pkt.timestampMs);
  }

  onSpeechEnded(pkt: VadSpeechEndedPacket, hasActiveTts: boolean): void {
    const pending = this.pendingFor(pkt.contextId);
    if (pending) {
      const durationMs = pkt.timestampMs - pending.firstSpeechMs;
      if (durationMs >= this.deps.minInterruptionMs) {
        if (
          this.deps.primarySpeakerGate.isEnabled() &&
          this.deps.primarySpeakerGate.hasProfile() &&
          !this.deps.primarySpeakerGate.shouldCommitBargeIn()
        ) {
          this.suppress(pending, "interrupt.suppressed_non_primary", durationMs);
        } else {
          this.tryCommit(pkt.timestampMs);
        }
      } else {
        this.suppress(pending, "interrupt.suppressed_short_speech", durationMs);
      }
      return;
    }

    if (!hasActiveTts) {
      this.deps.primarySpeakerGate.lockProfileFromFirstTurn();
    }
  }

  observeBargeInAudio(pkt: VadAudioPacket): boolean {
    const pending = this.pendingFor(pkt.contextId);
    if (!pending) return false;

    this.deps.primarySpeakerGate.observeBargeInChunk(pkt.audio);
    if (pending.awaitingAudio) {
      this.setAwaitingAudio(false);
      this.tryCommit(pkt.timestampMs);
    }
    return true;
  }

  emitInterruptDetected(interruptedContextId: string): void {
    this.deps.bus.push(Route.Critical, make.interruptDetected(interruptedContextId, Date.now(), "vad"));
  }

  clear(): void {
    this.turnInterruption = { kind: "idle" };
  }

  private pendingFor(userContextId: string): PendingTurnInterruption | null {
    const state = this.turnInterruption;
    if (state.kind !== "pending" || state.userContextId !== userContextId) return null;
    return state;
  }

  private transitionToPending(
    pkt: VadSpeechStartedPacket,
    interruptedContextId: string,
    awaitingAudio: boolean,
  ): void {
    this.deps.primarySpeakerGate.beginBargeInWindow();
    this.turnInterruption = {
      kind: "pending",
      userContextId: pkt.contextId,
      interruptedContextId,
      firstSpeechMs: pkt.timestampMs,
      awaitingAudio,
    };
  }

  private setAwaitingAudio(awaitingAudio: boolean): void {
    const state = this.turnInterruption;
    if (state.kind !== "pending") return;
    this.turnInterruption = { ...state, awaitingAudio };
  }

  private shouldDeferImmediateBargeInForSpeakerGate(): boolean {
    const gate = this.deps.primarySpeakerGate;
    return gate.isEnabled() && gate.hasProfile();
  }

  private tryCommit(nowMs: number): void {
    const pending = this.turnInterruption.kind === "pending" ? this.turnInterruption : null;
    if (!pending) return;
    if (nowMs - pending.firstSpeechMs < this.deps.minInterruptionMs) return;

    const gate = this.deps.primarySpeakerGate;
    if (gate.isEnabled() && gate.hasProfile() && !gate.shouldCommitBargeIn()) {
      this.suppress(pending, "interrupt.suppressed_non_primary", nowMs - pending.firstSpeechMs);
      return;
    }

    const sustainedMs = nowMs - pending.firstSpeechMs;
    this.turnInterruption = { kind: "idle" };
    gate.resetBargeInWindow();

    const { bus, ttsPlayout } = this.deps;
    if (!ttsPlayout.isActive(pending.interruptedContextId)) {
      bus.push(
        Route.Background,
        make.metric(pending.interruptedContextId, "interrupt.gate_resolved_after_tts_end", String(sustainedMs)),
      );
      return;
    }

    bus.push(
      Route.Background,
      make.metric(pending.interruptedContextId, "interrupt.committed_after_ms", String(sustainedMs)),
    );
    bus.push(Route.Background, make.metric(pending.interruptedContextId, "vaqi.interruption", "1"));
    bus.push(
      Route.Background,
      make.metric(pending.interruptedContextId, "interrupt.latency_ms", String(sustainedMs)),
    );
    this.emitInterruptDetected(pending.interruptedContextId);
  }

  private suppress(
    pending: PendingTurnInterruption,
    metricName: string,
    durationMs: number,
  ): void {
    if (metricName === "interrupt.suppressed_non_primary") {
      this.deps.primarySpeakerGate.beginBargeInWindow();
      this.turnInterruption = { ...pending };
    } else {
      this.turnInterruption = { kind: "idle" };
      this.deps.primarySpeakerGate.resetBargeInWindow();
    }
    this.deps.bus.push(
      Route.Background,
      make.metric(pending.interruptedContextId, metricName, String(durationMs)),
    );
  }
}
