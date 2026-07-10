// SPDX-License-Identifier: MIT

import type { VadAudioPacket } from "./packets.js";
import type { SttInterimPacket, SttResultPacket } from "./packets.js";
import { Route } from "./pipeline-bus.js";
import type { PipelineBus } from "./pipeline-bus.js";
import { confidenceToWaitMs } from "./confidence-to-wait.js";
import type { InteractionDecision, InteractionObservation, InteractionPolicy } from "./interaction-policy.js";
import type { TurnArbiter } from "./turn-arbiter.js";
import { RuleBasedInteractionPolicy } from "./policies/rule-based.js";
import { TimerScheduler, type Scheduler } from "./scheduler.js";
import * as make from "./packet-factories.js";

export interface InteractionCaps {
  readonly emitsBackchannel?: boolean;
}

interface PendingTakeTurn {
  confidence: number;
  waitMs?: number;
  transcripts: SttResultPacket[];
  latestInterim: string;
  finalizeRequested: boolean;
}

export class InteractionCoordinator {
  private readonly disposers: Array<() => void> = [];
  private readonly pendingTakeTurns = new Map<string, PendingTakeTurn>();
  private readonly transcriptsByContext = new Map<string, SttResultPacket[]>();
  private readonly interimByContext = new Map<string, string>();
  private readonly scheduler: Scheduler;

  constructor(
    private readonly deps: {
      bus: PipelineBus;
      policy: InteractionPolicy;
      executor: TurnArbiter;
      caps: InteractionCaps;
      scheduler?: Scheduler;
      isUserSpeaking?: () => boolean;
      isTtsActive?: () => boolean;
      hasCueAsset?: (cueId: string) => boolean;
      onBackchannelEmitted?: (contextId: string) => void;
    },
  ) {
    this.scheduler = deps.scheduler ?? new TimerScheduler();
  }

  initialize(): void {
    const { bus } = this.deps;
    this.disposers.push(
      bus.on("stt.result", (pkt) => {
        this.handleSttResult(pkt as SttResultPacket);
      }),
      bus.on("stt.interim", (pkt) => {
        this.handleSttInterim(pkt as SttInterimPacket);
      }),
      bus.on("vad.speech_started", (pkt) => {
        this.revokePendingTakeTurn((pkt as { contextId: string }).contextId);
      }),
    );
  }

  dispose(): void {
    for (const contextId of this.pendingTakeTurns.keys()) {
      this.revokePendingTakeTurn(contextId);
    }
    for (const dispose of this.disposers.splice(0)) {
      dispose();
    }
    this.transcriptsByContext.clear();
    this.interimByContext.clear();
  }

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
      case "take_turn":
        this.armTakeTurn(obs.contextId, d.confidence, d.waitMs, obs.timestampMs);
        break;
      case "hold":
      case "keep_listening":
        this.revokePendingTakeTurn(obs.contextId);
        break;
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

  private armTakeTurn(contextId: string, confidence: number, waitMs: number | undefined, timestampMs: number): void {
    const existing = this.pendingTakeTurns.get(contextId);
    const pending: PendingTakeTurn = existing ?? {
      confidence,
      transcripts: [...(this.transcriptsByContext.get(contextId) ?? [])],
      latestInterim: this.interimByContext.get(contextId) ?? "",
      finalizeRequested: false,
    };
    pending.confidence = confidence;
    pending.waitMs = waitMs;
    this.pendingTakeTurns.set(contextId, pending);

    if (!pending.finalizeRequested) {
      pending.finalizeRequested = true;
      this.deps.bus.push(Route.Critical, make.finalizeStt(contextId, timestampMs));
    }
    this.tryScheduleTurnComplete(contextId);
  }

  private handleSttInterim(pkt: SttInterimPacket): void {
    const text = pkt.text.trim();
    if (!text) return;
    this.interimByContext.set(pkt.contextId, text);
    const pending = this.pendingTakeTurns.get(pkt.contextId);
    if (pending) pending.latestInterim = text;
  }

  private handleSttResult(pkt: SttResultPacket): void {
    const text = pkt.text.trim();
    if (!text) return;
    const transcripts = this.transcriptsByContext.get(pkt.contextId) ?? [];
    if (transcripts.at(-1)?.text.trim() !== text) {
      transcripts.push(pkt);
      this.transcriptsByContext.set(pkt.contextId, transcripts);
    }
    this.interimByContext.delete(pkt.contextId);

    const pending = this.pendingTakeTurns.get(pkt.contextId);
    if (!pending) return;
    pending.transcripts = [...transcripts];
    pending.latestInterim = "";
    this.tryScheduleTurnComplete(pkt.contextId);
  }

  private tryScheduleTurnComplete(contextId: string): void {
    const pending = this.pendingTakeTurns.get(contextId);
    if (!pending) return;

    // Anchor the finalize timer at the policy's commitment even before any text
    // exists — the callback reads live transcript/interim state at fire time and
    // is the sole gate on whether the turn actually completes.
    const delayMs = pending.waitMs ?? confidenceToWaitMs(pending.confidence);
    const timerKey = takeTurnTimerKey(contextId);
    this.scheduler.cancel(timerKey);
    this.scheduler.schedule(timerKey, delayMs, () => {
      const live = this.pendingTakeTurns.get(contextId);
      if (!live) return;

      const finalText = joinTranscript(live.transcripts, live.latestInterim);
      // The policy committed to this turn. Prefer real STT finals; if none ever
      // arrived, fall back to the latest interim so a committed turn is never
      // silently dropped. Only bail when there is genuinely nothing to commit.
      if (!finalText) return;

      this.pendingTakeTurns.delete(contextId);
      const transcripts: SttResultPacket[] =
        live.transcripts.length > 0
          ? live.transcripts
          : [{ kind: "stt.result", contextId, timestampMs: Date.now(), text: finalText, confidence: 0 }];
      this.deps.bus.push(Route.Main, make.eosTurnComplete(contextId, Date.now(), finalText, transcripts));
    });
  }

  private revokePendingTakeTurn(contextId: string): void {
    if (!this.pendingTakeTurns.has(contextId)) return;
    this.scheduler.cancel(takeTurnTimerKey(contextId));
    this.pendingTakeTurns.delete(contextId);
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
    this.revokePendingTakeTurn(contextId);
    this.transcriptsByContext.delete(contextId);
    this.interimByContext.delete(contextId);
    this.deps.policy.reset(contextId);
  }
}

function takeTurnTimerKey(contextId: string): string {
  return `interaction.take_turn:${contextId}`;
}

function joinTranscript(transcripts: readonly SttResultPacket[], interim: string): string {
  const segments = [
    ...transcripts.map((t) => t.text.trim()),
    ...(interim ? [interim.trim()] : []),
  ].filter(Boolean);
  return segments.join(" ").replace(/\s+/g, " ").trim();
}
