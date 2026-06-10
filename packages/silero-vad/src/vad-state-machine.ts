// SPDX-License-Identifier: MIT
//
// Shared Silero VAD turn state machine + PCM windowing — the single source of
// truth for both the Node (onnxruntime-node) and Workers (onnxruntime-web)
// plugins. The two runtimes differ only in how the ONNX session is created and
// where the model bytes come from; everything that decides "is the user
// speaking" lives here so the variants can never drift again (v2.1.0 shipped
// the telephony saturation hardening in the Node copy only).

import {
  Route,
  type PipelineBus,
  type PluginConfig,
  type VadSpeechActivityPacket,
  type VadSpeechEndedPacket,
  type VadSpeechStartedPacket,
} from "@kuralle-syrinx/core";
import { pcm16BytesToSamples } from "@kuralle-syrinx/core/audio";

export const WINDOW_SAMPLES_16K = 512;
export const CONTEXT_SAMPLES_16K = 64;

const QUIET_MODEL_RESET_INTERVAL_MS = 5000;

type VadState = "quiet" | "starting" | "speaking" | "stopping";

export interface VadTuning {
  readonly confidenceThreshold: number;
  readonly minSilenceDurationMs: number;
  readonly speechPadMs: number;
  readonly speechStartDurationMs: number;
  readonly speakingStateResetIntervalMs: number;
}

export function readVadTuning(config: PluginConfig): VadTuning {
  return {
    confidenceThreshold: readNumber(config, "threshold", 0.5),
    minSilenceDurationMs: readNumber(config, "min_silence_duration_ms", 200),
    speechPadMs: readNumber(config, "speech_pad_ms", 80),
    speechStartDurationMs: readNumber(config, "speech_start_duration_ms", 32),
    speakingStateResetIntervalMs: readNumber(config, "speaking_state_reset_interval_ms", 12_000),
  };
}

/** Accumulates inbound PCM16 bytes and yields normalized 512-sample model windows. */
export class Pcm16WindowBuffer {
  private pendingSamples: number[] = [];

  push(audio: Uint8Array): void {
    const samples = pcm16BytesToSamples(audio);
    for (let i = 0; i < samples.length; i += 1) {
      this.pendingSamples.push(samples[i]! / 32768);
    }
  }

  next(): Float32Array | null {
    if (this.pendingSamples.length < WINDOW_SAMPLES_16K) return null;
    const window = new Float32Array(WINDOW_SAMPLES_16K);
    for (let i = 0; i < WINDOW_SAMPLES_16K; i += 1) {
      window[i] = this.pendingSamples.shift()!;
    }
    return window;
  }

  clear(): void {
    this.pendingSamples = [];
  }
}

export class SileroVadStateMachine {
  private vadState: VadState = "quiet";
  private speechFrames = 0;
  private silenceFrames = 0;
  private stoppingSpikeFrames = 0;
  private lastResetMs = Date.now();

  constructor(
    private readonly bus: PipelineBus,
    private readonly tuning: VadTuning,
    /** Zero the runtime's model state/context tensors; the machine owns when. */
    private readonly onModelReset: () => void,
  ) {}

  noteModelReset(): void {
    this.lastResetMs = Date.now();
  }

  observe(confidence: number, contextId: string): void {
    const now = Date.now();

    // Long-quiet model reset: keep the LSTM fresh between utterances.
    if (this.vadState === "quiet" && now - this.lastResetMs >= QUIET_MODEL_RESET_INTERVAL_MS) {
      this.onModelReset();
      this.lastResetMs = now;
    }

    const isSpeech = confidence >= this.tuning.confidenceThreshold;
    const silenceFrameTarget = Math.max(1, Math.ceil(this.tuning.minSilenceDurationMs / 32));

    switch (this.vadState) {
      case "quiet":
        if (isSpeech) {
          this.vadState = "starting";
          this.speechFrames = 1;
          this.promoteStartingToSpeakingIfReady(confidence, contextId, now);
        }
        break;

      case "starting":
        if (isSpeech) {
          if (!this.promoteStartingToSpeakingIfReady(confidence, contextId, now)) {
            this.speechFrames += 1;
            this.promoteStartingToSpeakingIfReady(confidence, contextId, now);
          }
        } else {
          this.vadState = "quiet";
          this.speechFrames = 0;
        }
        break;

      case "speaking":
        if (isSpeech) {
          // Silero v5 LSTM state saturates on long continuous segments
          // (telephony monologues): confidence then flaps high through genuine
          // silence and the end never fires. Periodically reset model state
          // mid-speech; the spike debounce in "stopping" makes the brief
          // post-reset confidence dip harmless for real speech.
          if (now - this.lastResetMs >= this.tuning.speakingStateResetIntervalMs) {
            this.onModelReset();
            this.lastResetMs = now;
            this.bus.push(Route.Main, {
              kind: "metric.conversation",
              contextId,
              timestampMs: now,
              name: "vad.state_reset_in_speech",
              value: "1",
            });
          }
          this.emitSpeechActivity(contextId, now);
        } else {
          this.vadState = "stopping";
          this.silenceFrames = 1;
          this.stoppingSpikeFrames = 0;
        }
        break;

      case "stopping":
        if (isSpeech) {
          // Single-frame confidence spikes are a known Silero failure mode on
          // long telephony segments (state saturation flaps high through real
          // silence). Require sustained speech to leave "stopping" so one
          // spike cannot reset the silence countdown forever.
          this.stoppingSpikeFrames += 1;
          if (this.stoppingSpikeFrames >= 2) {
            this.vadState = "speaking";
            this.silenceFrames = 0;
            this.stoppingSpikeFrames = 0;
            this.emitSpeechActivity(contextId, now);
          }
          break;
        }
        this.stoppingSpikeFrames = 0;
        this.silenceFrames += 1;
        if (this.silenceFrames * 32 < this.tuning.minSilenceDurationMs + this.tuning.speechPadMs) break;
        if (this.silenceFrames < silenceFrameTarget) break;

        {
          const hangoverMs = this.silenceFrames * 32;
          this.vadState = "quiet";
          this.silenceFrames = 0;
          this.speechFrames = 0;
          this.stoppingSpikeFrames = 0;
          const ended: VadSpeechEndedPacket = {
            kind: "vad.speech_ended",
            contextId,
            timestampMs: now,
          };
          this.bus.push(Route.Main, ended);
          this.bus.push(Route.Main, {
            kind: "metric.conversation",
            contextId,
            timestampMs: now,
            name: "vad.stop_hangover_ms",
            value: String(hangoverMs),
          });
        }
        break;
    }
  }

  private promoteStartingToSpeakingIfReady(
    confidence: number,
    contextId: string,
    now: number,
  ): boolean {
    if (this.vadState !== "starting") return false;
    if (this.speechFrames * 32 < this.tuning.speechStartDurationMs) return false;

    const startDelayMs = this.speechFrames * 32;
    this.vadState = "speaking";
    this.speechFrames = 0;
    const started: VadSpeechStartedPacket = {
      kind: "vad.speech_started",
      contextId,
      timestampMs: now,
      confidence,
    };
    this.bus.push(Route.Main, started);
    this.bus.push(Route.Main, {
      kind: "metric.conversation",
      contextId,
      timestampMs: now,
      name: "vad.start_delay_ms",
      value: String(startDelayMs),
    });
    this.emitSpeechActivity(contextId, now);
    return true;
  }

  private emitSpeechActivity(contextId: string, now: number): void {
    const activity: VadSpeechActivityPacket = {
      kind: "vad.speech_activity",
      contextId,
      timestampMs: now,
      isAsync: true,
    };
    this.bus.push(Route.Main, activity);
  }
}

function readNumber(config: PluginConfig, key: string, fallback: number): number {
  const value = config[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
