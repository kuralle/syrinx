// SPDX-License-Identifier: MIT

import { Route, type PipelineBus } from "./pipeline-bus.js";
import type { SttResultPacket } from "./packets.js";
import { ErrorCategory, SessionState } from "./packets.js";
import type { VoicePlugin } from "./plugin-contract.js";
import { TimerScheduler, type Scheduler } from "./scheduler.js";
import { TtsPlayoutClock } from "./tts-playout-clock.js";
import * as make from "./packet-factories.js";

export function estimatePcm16Duration(audio: Uint8Array, sampleRate: number): number {
  const samples = audio.length / 2;
  return (samples / sampleRate) * 1000;
}

export function requireTtsAudioSampleRate(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error("tts.audio sampleRateHz must be a positive integer");
  }
  return value;
}

export function languageFromTranscripts(transcripts: readonly SttResultPacket[]): string {
  for (const transcript of transcripts) {
    if (transcript.language) {
      return transcript.language;
    }
  }
  return "";
}

interface ForceFinalizableSttPlugin extends VoicePlugin {
  forceFinalize(contextId?: string): void;
}

export function findForceFinalizableSttPlugin(
  plugins: ReadonlyMap<string, VoicePlugin>,
): ForceFinalizableSttPlugin | null {
  for (const name of ["stt", "deepgram"]) {
    const plugin = plugins.get(name);
    if (isForceFinalizableSttPlugin(plugin)) {
      return plugin;
    }
  }

  for (const plugin of plugins.values()) {
    if (isForceFinalizableSttPlugin(plugin)) {
      return plugin;
    }
  }

  return null;
}

function isForceFinalizableSttPlugin(
  plugin: VoicePlugin | undefined,
): plugin is ForceFinalizableSttPlugin {
  return (
    typeof plugin === "object" &&
    plugin !== null &&
    "forceFinalize" in plugin &&
    typeof plugin.forceFinalize === "function"
  );
}

export interface VoiceSessionWatchdogsDeps {
  readonly bus: PipelineBus;
  readonly plugins: ReadonlyMap<string, VoicePlugin>;
  readonly ttsPlayout: TtsPlayoutClock;
  readonly sttForceFinalizeTimeoutMs: number;
  readonly vaqiMissedResponseMs: number;
  readonly ttsStallMs: number;
  readonly inputCadenceTimeoutMs: number;
  readonly getSessionState: () => SessionState;
  readonly isGenerationInterrupted: (contextId: string) => boolean;
  readonly onVaqiMissedResponseFired: (contextId: string) => void;
  readonly scheduler?: Scheduler;
}

export class VoiceSessionWatchdogs {
  private readonly scheduler: Scheduler;
  private sttForceFinalizeScheduled = false;
  private pendingSttContextId = "";
  private vaqiMissedResponseScheduled = false;
  private vaqiMissedResponseContextId = "";
  private vaqiMissedResponseStartMs = 0;
  private ttsStallScheduled = false;
  private ttsStallContextId = "";
  private inputCadenceScheduled = false;
  private inputCadenceContextId = "";

  constructor(private readonly deps: VoiceSessionWatchdogsDeps) {
    this.scheduler = deps.scheduler ?? new TimerScheduler();
  }

  dispose(): void {
    this.clearSttForceFinalizeTimer();
    this.clearVaqiMissedResponseTimer();
    this.clearTtsStallTimer();
    this.clearInputCadenceWatchdog();
  }

  scheduleSttForceFinalize(contextId: string): void {
    if (this.deps.getSessionState() !== SessionState.Ready) return;
    if (this.deps.sttForceFinalizeTimeoutMs <= 0) return;

    this.pendingSttContextId = contextId;
    this.clearSttForceFinalizeTimer(false);
    this.sttForceFinalizeScheduled = true;
    this.scheduler.schedule("voice.watchdog.stt_force_finalize", this.deps.sttForceFinalizeTimeoutMs, () => {
      this.sttForceFinalizeScheduled = false;
      const plugin = findForceFinalizableSttPlugin(this.deps.plugins);
      plugin?.forceFinalize(contextId);
    });
  }

  clearSttForceFinalizeIfContext(contextId: string): void {
    if (this.pendingSttContextId === contextId) {
      this.clearSttForceFinalizeTimer();
    }
  }

  startVaqiMissedResponseTimer(contextId: string, startMs: number): void {
    if (this.deps.vaqiMissedResponseMs <= 0) return;
    this.clearVaqiMissedResponseTimer();
    this.vaqiMissedResponseContextId = contextId;
    this.vaqiMissedResponseStartMs = startMs;
    this.vaqiMissedResponseScheduled = true;
    this.scheduler.schedule("voice.watchdog.vaqi_missed_response", this.deps.vaqiMissedResponseMs, () => {
      this.vaqiMissedResponseScheduled = false;
      const cid = this.vaqiMissedResponseContextId;
      const elapsedMs = Date.now() - this.vaqiMissedResponseStartMs;
      this.vaqiMissedResponseContextId = "";
      this.vaqiMissedResponseStartMs = 0;
      this.deps.onVaqiMissedResponseFired(cid);
      this.deps.bus.push(Route.Background, make.metric(cid, "vaqi.missed_response", String(elapsedMs)));
    });
  }

  clearVaqiIfContext(contextId: string): void {
    if (this.vaqiMissedResponseContextId === contextId) {
      this.clearVaqiMissedResponseTimer();
    }
  }

  armTtsStallTimer(contextId: string): void {
    if (this.deps.ttsStallMs <= 0) return;
    this.clearTtsStallTimer();
    this.ttsStallContextId = contextId;
    this.ttsStallScheduled = true;
    this.scheduler.schedule("voice.watchdog.tts_stall", this.deps.ttsStallMs, () => {
      this.ttsStallScheduled = false;
      const cid = this.ttsStallContextId;
      this.ttsStallContextId = "";
      if (this.deps.isGenerationInterrupted(cid)) return;
      if (!this.deps.ttsPlayout.isActive(cid)) return;
      this.deps.ttsPlayout.release(cid);
      this.deps.bus.push(Route.Background, make.metric(cid, "tts.stall_detected", String(this.deps.ttsStallMs)));
      this.deps.bus.push(
        Route.Critical,
        make.ttsError(
          cid,
          Date.now(),
          new Error(`TTS output stalled: no audio or tts.end for ${String(this.deps.ttsStallMs)}ms`),
          ErrorCategory.NetworkTimeout,
          true,
        ),
      );
    });
  }

  clearTtsStallTimerFor(contextId: string): void {
    if (this.ttsStallContextId === contextId) this.clearTtsStallTimer();
  }

  scheduleInputCadenceWatchdog(contextId: string): void {
    if (this.deps.inputCadenceTimeoutMs <= 0) return;
    if (this.deps.getSessionState() !== SessionState.Ready) return;

    this.clearInputCadenceWatchdog();
    this.inputCadenceContextId = contextId;
    this.inputCadenceScheduled = true;
    this.scheduler.schedule("voice.watchdog.input_cadence", this.deps.inputCadenceTimeoutMs, () => {
      this.inputCadenceScheduled = false;
      const cid = this.inputCadenceContextId;
      if (this.deps.getSessionState() !== SessionState.Ready) return;

      this.deps.bus.push(
        Route.Background,
        make.metric(cid, "input.cadence_stall_ms", String(this.deps.inputCadenceTimeoutMs)),
      );
      this.deps.bus.push(Route.Critical, {
        kind: "pipeline.error",
        contextId: cid,
        timestampMs: Date.now(),
        component: "pipeline",
        category: ErrorCategory.NetworkTimeout,
        cause: new Error("inbound audio stalled"),
        isRecoverable: true,
      });

      this.scheduleInputCadenceWatchdog(cid);
    });
  }

  clearInputCadenceWatchdog(): void {
    if (this.inputCadenceScheduled) {
      this.scheduler.cancel("voice.watchdog.input_cadence");
      this.inputCadenceScheduled = false;
    }
    this.inputCadenceContextId = "";
  }

  private clearSttForceFinalizeTimer(clearContext = true): void {
    if (this.sttForceFinalizeScheduled) {
      this.scheduler.cancel("voice.watchdog.stt_force_finalize");
      this.sttForceFinalizeScheduled = false;
    }
    if (clearContext) {
      this.pendingSttContextId = "";
    }
  }

  private clearVaqiMissedResponseTimer(): void {
    if (this.vaqiMissedResponseScheduled) {
      this.scheduler.cancel("voice.watchdog.vaqi_missed_response");
      this.vaqiMissedResponseScheduled = false;
    }
    this.vaqiMissedResponseContextId = "";
    this.vaqiMissedResponseStartMs = 0;
  }

  private clearTtsStallTimer(): void {
    if (this.ttsStallScheduled) {
      this.scheduler.cancel("voice.watchdog.tts_stall");
      this.ttsStallScheduled = false;
    }
    this.ttsStallContextId = "";
  }
}
