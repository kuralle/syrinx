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
type StageDims = Partial<ObservabilityDims> & { cancelled?: boolean };

export class ObservabilityObserver {
  private readonly boundaryTimes = new Map<string, BoundaryTimes>();
  private readonly stageDims = new Map<string, StageDims>();
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
    this.stageDims.clear();
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
    const provider = pkt.transcripts[0]?.provider;
    if (provider) this.mergeStageDims(this.speechId(pkt.contextId), provider);
    this.emitBoundary(this.speechId(pkt.contextId), "agent_thinking");
  }

  private onTtsAudio(pkt: TextToSpeechAudioPacket): void {
    const id = pkt.contextId;
    if (pkt.provider) this.mergeStageDims(id, pkt.provider);
    if (this.agentStartedEmitted.has(id)) return;
    this.agentStartedEmitted.add(id);
    this.emitBoundary(id, "agent_started_speaking");
  }

  private onTtsEnd(pkt: TextToSpeechEndPacket): void {
    this.emitBoundary(this.speechId(pkt.contextId), "agent_audio_done");
  }

  private onInterruptDetected(pkt: InterruptionDetectedPacket): void {
    this.stageDims.set(this.speechId(pkt.contextId), {
      ...this.stageDims.get(this.speechId(pkt.contextId)),
      cancelled: true,
    });
    this.emitBoundary(this.speechId(pkt.contextId), "interruption", true);
  }

  private emitBoundary(speechId: string, boundary: TurnBoundaryKind, cancelled = false): void {
    const now = monotonicNowMs();
    let times = this.boundaryTimes.get(speechId);
    if (!times) {
      times = {};
      this.boundaryTimes.set(speechId, times);
    }

    const dims = this.dimsFor(speechId, cancelled);
    const tags = {
      sessionId: this.deps.sessionId,
      speechId,
      provider: dims.provider,
      model: dims.model,
      region: dims.region,
      cancelled: dims.cancelled ? "true" : "false",
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
        provider: dims.provider,
        model: dims.model,
        region: dims.region,
        cancelled: dims.cancelled || undefined,
      }),
    );
  }

  private mergeStageDims(speechId: string, provider: Record<string, unknown>): void {
    const current = this.stageDims.get(speechId) ?? {};
    this.stageDims.set(speechId, {
      ...current,
      provider: readString(provider["name"], readString(provider["provider"], current.provider)),
      model: readString(provider["model"], current.model),
      region: readString(provider["region"], current.region),
      cancelled: typeof provider["cancelled"] === "boolean" ? provider["cancelled"] : current.cancelled,
    });
  }

  private dimsFor(speechId: string, cancelled: boolean): Required<ObservabilityDims> & { cancelled: boolean } {
    const stage = this.stageDims.get(speechId) ?? {};
    return {
      provider: stage.provider ?? this.deps.dims.provider,
      model: stage.model ?? this.deps.dims.model,
      region: stage.region ?? this.deps.dims.region,
      cancelled: cancelled || stage.cancelled === true,
    };
  }
}

function readString(value: unknown, fallback: string | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}
