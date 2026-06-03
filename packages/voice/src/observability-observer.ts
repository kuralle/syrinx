// SPDX-License-Identifier: MIT

import { Route, type PipelineBus } from "./pipeline-bus.js";
import { monotonicNowMs, type MetricsExporter } from "./observability.js";
import type {
  TurnBoundaryKind,
  VadSpeechStartedPacket,
  VadSpeechEndedPacket,
  EndOfSpeechPacket,
  TextToSpeechAudioPacket,
  TextToSpeechEndPacket,
  InterruptionDetectedPacket,
} from "./packets.js";
import * as make from "./packet-factories.js";

export interface ObservabilityDims {
  readonly provider: string;
  readonly model: string;
  readonly region: string;
}

export interface ObservabilityObserverDeps {
  readonly bus: PipelineBus;
  readonly exporter: MetricsExporter;
  readonly sessionId: string;
  readonly dims: ObservabilityDims;
  readonly getContextId: () => string;
}

type BoundaryTimes = Partial<Record<TurnBoundaryKind, number>>;

export class ObservabilityObserver {
  private readonly boundaryTimes = new Map<string, BoundaryTimes>();
  private readonly agentStartedEmitted = new Set<string>();
  private readonly unsubscribes: Array<() => void> = [];

  constructor(private readonly deps: ObservabilityObserverDeps) {}

  wire(disposers?: Array<() => void>): void {
    const reg = (unsub: () => void): void => {
      this.unsubscribes.push(unsub);
      disposers?.push(unsub);
    };

    reg(
      this.deps.bus.on("vad.speech_started", (pkt) =>
        this.onVadSpeechStarted(pkt as VadSpeechStartedPacket),
      ),
    );
    reg(
      this.deps.bus.on("vad.speech_ended", (pkt) =>
        this.onVadSpeechEnded(pkt as VadSpeechEndedPacket),
      ),
    );
    reg(
      this.deps.bus.on("eos.turn_complete", (pkt) =>
        this.onTurnComplete(pkt as EndOfSpeechPacket),
      ),
    );
    reg(this.deps.bus.on("tts.audio", (pkt) => this.onTtsAudio(pkt as TextToSpeechAudioPacket)));
    reg(this.deps.bus.on("tts.end", (pkt) => this.onTtsEnd(pkt as TextToSpeechEndPacket)));
    reg(
      this.deps.bus.on("interrupt.detected", (pkt) =>
        this.onInterruptDetected(pkt as InterruptionDetectedPacket),
      ),
    );
  }

  dispose(): void {
    for (const unsub of this.unsubscribes) unsub();
    this.unsubscribes.length = 0;
    this.boundaryTimes.clear();
    this.agentStartedEmitted.clear();
  }

  private speechId(contextId: string): string {
    return contextId || this.deps.getContextId();
  }

  private onVadSpeechStarted(pkt: VadSpeechStartedPacket): void {
    this.emitBoundary(this.speechId(pkt.contextId), "user_started_speaking");
  }

  private onVadSpeechEnded(pkt: VadSpeechEndedPacket): void {
    this.emitBoundary(this.speechId(pkt.contextId), "user_stopped_speaking");
  }

  private onTurnComplete(pkt: EndOfSpeechPacket): void {
    this.emitBoundary(this.speechId(pkt.contextId), "agent_thinking");
  }

  private onTtsAudio(pkt: TextToSpeechAudioPacket): void {
    const id = pkt.contextId;
    if (this.agentStartedEmitted.has(id)) return;
    this.agentStartedEmitted.add(id);
    this.emitBoundary(id, "agent_started_speaking");
  }

  private onTtsEnd(pkt: TextToSpeechEndPacket): void {
    this.emitBoundary(this.speechId(pkt.contextId), "agent_audio_done");
  }

  private onInterruptDetected(pkt: InterruptionDetectedPacket): void {
    this.emitBoundary(this.speechId(pkt.contextId), "interruption", true);
  }

  private emitBoundary(speechId: string, boundary: TurnBoundaryKind, cancelled = false): void {
    const now = monotonicNowMs();
    let times = this.boundaryTimes.get(speechId);
    if (!times) {
      times = {};
      this.boundaryTimes.set(speechId, times);
    }

    const tags = {
      sessionId: this.deps.sessionId,
      speechId,
      provider: this.deps.dims.provider,
      model: this.deps.dims.model,
      region: this.deps.dims.region,
      cancelled: cancelled ? "true" : "false",
    };

    if (boundary === "agent_started_speaking") {
      const stopped = times.user_stopped_speaking;
      if (stopped !== undefined) {
        const delta = now - stopped;
        if (delta >= 0) this.deps.exporter.observeHistogram("v2v_ms", delta, tags);
      }
      const thinking = times.agent_thinking;
      if (thinking !== undefined) {
        const delta = now - thinking;
        if (delta >= 0) this.deps.exporter.observeHistogram("thinking_ms", delta, tags);
      }
    } else if (boundary === "agent_audio_done") {
      const started = times.agent_started_speaking;
      if (started !== undefined) {
        const delta = now - started;
        if (delta >= 0) this.deps.exporter.observeHistogram("agent_speech_ms", delta, tags);
      }
    }

    times[boundary] = now;

    this.deps.bus.push(
      Route.Background,
      make.turnBoundary(speechId, Date.now(), {
        boundary,
        sessionId: this.deps.sessionId,
        speechId,
        monotonicMs: now,
        provider: this.deps.dims.provider,
        model: this.deps.dims.model,
        region: this.deps.dims.region,
        cancelled: cancelled || undefined,
      }),
    );
  }
}
