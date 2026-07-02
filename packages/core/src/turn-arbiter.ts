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

const BACKCHANNELS = new Set([
  "yeah",
  "yep",
  "yup",
  "uh huh",
  "uhhuh",
  "uh-huh",
  "mhm",
  "mm hmm",
  "mm-hmm",
  "mmhmm",
  "okay",
  "ok",
  "right",
  "sure",
  "uh",
  "um",
  "hmm",
  "i see",
  "got it",
  "gotcha",
  "oh",
]);

export function isBackchannel(text: string): boolean {
  const norm = text
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, "")
    .trim()
    .replace(/\s+/g, " ");
  if (!norm) return false;
  return BACKCHANNELS.has(norm);
}

export interface TurnArbiterDeps {
  readonly bus: PipelineBus;
  readonly primarySpeakerGate: PrimarySpeakerGate;
  readonly ttsPlayout: TtsPlayoutClock;
  readonly minInterruptionMs: number;
}

export class TurnArbiter {
  private turnInterruption: TurnInterruptionState = { kind: "idle" };
  private latestInterimText = "";
  private latestInterimConfidence: number | null = null;

  constructor(private readonly deps: TurnArbiterDeps) {}

  noteInterimEvidence(text: string, confidence?: number): void {
    this.latestInterimText = text;
    this.latestInterimConfidence = typeof confidence === "number" ? confidence : null;
  }

  onSpeechStarted(pkt: VadSpeechStartedPacket, interruptedContextId: string): void {
    const { minInterruptionMs, bus, primarySpeakerGate } = this.deps;

    // Idempotent for an already-pending barge-in: with both a local VAD and a
    // provider STT emitting speech-start (vad_events), the later event must not
    // reset firstSpeechMs and delay the commit.
    if (this.pendingFor(pkt.contextId)) return;

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

  // Barge-in evidence for deployments where the provider STT owns endpointing and
  // no VAD plugin emits vad.speech_started: interim/final transcripts arriving
  // while TTS playout is active are the speech signal. First evidence opens the
  // pending window; later evidence commits once sustained past minInterruptionMs,
  // through the same backchannel / low-confidence / speaker-gate suppression.
  onProviderSttEvidence(userContextId: string, timestampMs: number, interruptedContextId: string): void {
    const state = this.turnInterruption;
    if (state.kind === "pending") {
      if (state.userContextId !== userContextId) return;
      this.tryCommit(timestampMs);
      return;
    }
    this.transitionToPending({ contextId: userContextId, timestampMs }, interruptedContextId, false);
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

  commitClientInterrupt(interruptedContextId: string): void {
    if (!this.deps.ttsPlayout.isActive(interruptedContextId)) return;
    this.turnInterruption = { kind: "idle" };
    this.deps.primarySpeakerGate.resetBargeInWindow();
    this.deps.bus.push(Route.Background, make.metric(interruptedContextId, "interrupt.committed_after_ms", "0"));
    this.deps.bus.push(Route.Background, make.metric(interruptedContextId, "vaqi.interruption", "1"));
    this.deps.bus.push(Route.Background, make.metric(interruptedContextId, "interrupt.latency_ms", "0"));
    this.deps.bus.push(Route.Critical, make.interruptDetected(interruptedContextId, Date.now(), "client"));
  }

  clear(): void {
    this.turnInterruption = { kind: "idle" };
    this.latestInterimText = "";
    this.latestInterimConfidence = null;
  }

  private pendingFor(userContextId: string): PendingTurnInterruption | null {
    const state = this.turnInterruption;
    if (state.kind !== "pending" || state.userContextId !== userContextId) return null;
    return state;
  }

  private transitionToPending(
    pkt: Pick<VadSpeechStartedPacket, "contextId" | "timestampMs">,
    interruptedContextId: string,
    awaitingAudio: boolean,
  ): void {
    this.deps.primarySpeakerGate.beginBargeInWindow();
    // Reset interim evidence so a stale low-confidence/backchannel interim from a
    // previous turn cannot suppress this new turn's barge-in. The current turn's
    // own interims (noteInterimEvidence) repopulate it before tryCommit reads it.
    this.latestInterimText = "";
    this.latestInterimConfidence = null;
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
    if (this.latestInterimConfidence !== null && this.latestInterimConfidence < 0.5) {
      this.suppress(pending, "interrupt.suppressed_low_confidence", sustainedMs);
      return;
    }
    if (this.latestInterimText && isBackchannel(this.latestInterimText)) {
      this.suppress(pending, "interrupt.suppressed_backchannel", sustainedMs);
      return;
    }
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
    this.latestInterimText = "";
    this.latestInterimConfidence = null;
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
    this.latestInterimText = "";
    this.latestInterimConfidence = null;
  }
}
