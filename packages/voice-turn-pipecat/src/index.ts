// SPDX-License-Identifier: MIT

import {
  Route,
  type EndOfSpeechPacket,
  type InterimEndOfSpeechPacket,
  type PipelineBus,
  type PluginConfig,
  type SttInterimPacket,
  type SttResultPacket,
  type VadSpeechEndedPacket,
  type VadSpeechStartedPacket,
  type VoicePlugin,
} from "@asyncdot/voice";

interface TurnState {
  readonly contextId: string;
  finalText: string;
  finalPacket: SttResultPacket | null;
  vadStopped: boolean;
  finalizeTimer: ReturnType<typeof setTimeout> | null;
  maxTimer: ReturnType<typeof setTimeout> | null;
  finalized: boolean;
}

export interface PipecatEOSTiming {
  readonly finalizeDelayMs: number;
  readonly maxDelayMs: number;
}

export class PipecatEOSPlugin implements VoicePlugin {
  private bus: PipelineBus | null = null;
  private disposers: Array<() => void> = [];
  private turns = new Map<string, TurnState>();
  private finalizeDelayMs = 250;
  private maxDelayMs = 2000;

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    this.finalizeDelayMs = readNonNegativeNumber(config["finalize_delay_ms"], 250);
    this.maxDelayMs = readNonNegativeNumber(config["max_delay_ms"], 2000);

    this.disposers.push(
      bus.on("stt.interim", (pkt) => {
        this.handleInterim(pkt as SttInterimPacket);
      }),
      bus.on("stt.result", (pkt) => {
        this.handleFinal(pkt as SttResultPacket);
      }),
      bus.on("vad.speech_started", (pkt) => {
        this.handleSpeechStarted(pkt as VadSpeechStartedPacket);
      }),
      bus.on("vad.speech_ended", (pkt) => {
        this.handleSpeechEnded(pkt as VadSpeechEndedPacket);
      }),
    );
  }

  async close(): Promise<void> {
    for (const dispose of this.disposers.splice(0)) {
      dispose();
    }
    for (const state of this.turns.values()) {
      clearTurnTimers(state);
    }
    this.turns.clear();
    this.bus = null;
  }

  private handleInterim(pkt: SttInterimPacket): void {
    if (!pkt.text.trim()) return;
    this.bus?.push(Route.Main, {
      kind: "eos.interim",
      contextId: pkt.contextId,
      timestampMs: Date.now(),
      text: pkt.text,
    } satisfies InterimEndOfSpeechPacket);
  }

  private handleFinal(pkt: SttResultPacket): void {
    if (!pkt.text.trim()) return;
    const state = this.stateFor(pkt.contextId);
    state.finalText = pkt.text;
    state.finalPacket = pkt;

    if (state.vadStopped) {
      this.scheduleFinalize(state, this.finalizeDelayMs);
      return;
    }
    this.scheduleMaxFinalize(state);
  }

  private handleSpeechStarted(pkt: VadSpeechStartedPacket): void {
    const state = this.stateFor(pkt.contextId);
    state.vadStopped = false;
    if (state.finalizeTimer) {
      clearTimeout(state.finalizeTimer);
      state.finalizeTimer = null;
    }
  }

  private handleSpeechEnded(pkt: VadSpeechEndedPacket): void {
    const state = this.stateFor(pkt.contextId);
    state.vadStopped = true;
    if (state.finalPacket) {
      this.scheduleFinalize(state, this.finalizeDelayMs);
    }
  }

  private stateFor(contextId: string): TurnState {
    const existing = this.turns.get(contextId);
    if (existing) return existing;

    const state: TurnState = {
      contextId,
      finalText: "",
      finalPacket: null,
      vadStopped: false,
      finalizeTimer: null,
      maxTimer: null,
      finalized: false,
    };
    this.turns.set(contextId, state);
    return state;
  }

  private scheduleFinalize(state: TurnState, delayMs: number): void {
    if (state.finalized || state.finalizeTimer) return;
    state.finalizeTimer = setTimeout(() => {
      state.finalizeTimer = null;
      this.finalize(state);
    }, delayMs);
  }

  private scheduleMaxFinalize(state: TurnState): void {
    if (state.finalized || state.maxTimer || this.maxDelayMs <= 0) return;
    state.maxTimer = setTimeout(() => {
      state.maxTimer = null;
      this.finalize(state);
    }, this.maxDelayMs);
  }

  private finalize(state: TurnState): void {
    if (state.finalized || !state.finalPacket || !state.finalText.trim()) return;
    state.finalized = true;
    clearTurnTimers(state);
    this.bus?.push(Route.Main, {
      kind: "eos.turn_complete",
      contextId: state.contextId,
      timestampMs: Date.now(),
      text: state.finalText,
      transcripts: [state.finalPacket],
    } satisfies EndOfSpeechPacket);
    this.turns.delete(state.contextId);
  }
}

function clearTurnTimers(state: TurnState): void {
  if (state.finalizeTimer) clearTimeout(state.finalizeTimer);
  if (state.maxTimer) clearTimeout(state.maxTimer);
  state.finalizeTimer = null;
  state.maxTimer = null;
}

function readNonNegativeNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}
