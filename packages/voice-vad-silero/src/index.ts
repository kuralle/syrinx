// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Silero VAD Plugin
//
// Implements VoicePlugin contract. Receives PipelineBus, pushes VAD speech
// start/end/activity events into the bus.

import type { PipelineBus } from "@asyncdot/voice";
import { Route, type VoicePlugin, type PluginConfig } from "@asyncdot/voice";

export class SileroVADPlugin implements VoicePlugin {
  private bus: PipelineBus | null = null;
  private speaking = false;
  private confidenceThreshold: number;

  constructor() {
    this.confidenceThreshold = 0.5;
  }

  async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.bus = bus;
    this.confidenceThreshold = (config["threshold"] as number) ?? 0.5;
  }

  /**
   * Process an audio frame and emit VAD events.
   * Called when "vad.audio" packets arrive on the bus.
   * In a real implementation, this would run Silero ONNX inference.
   * This stub uses a mock that alternates speech/silence.
   */
  processAudio(audio: Uint8Array, contextId: string): void {
    if (!this.bus) return;

    // Stub: mock VAD detection (real impl uses ONNX inference)
    const energy = this.computeEnergy(audio);
    const isSpeech = energy > this.confidenceThreshold;
    const confidence = Math.min(energy / 2, 1.0);
    const now = Date.now();

    if (isSpeech && !this.speaking) {
      this.speaking = true;
      this.bus.push(Route.Main, {
        kind: "vad.speech_started",
        contextId,
        timestampMs: now,
        confidence,
      });
    }

    if (!isSpeech && this.speaking) {
      this.speaking = false;
      this.bus.push(Route.Main, {
        kind: "vad.speech_ended",
        contextId,
        timestampMs: now,
      });
    }

    // Emit speech activity heartbeat while speaking (EOS uses this)
    if (this.speaking) {
      this.bus.push(Route.Main, {
        kind: "vad.speech_activity",
        contextId,
        timestampMs: now,
        isAsync: true,
      });
    }
  }

  private computeEnergy(audio: Uint8Array): number {
    // Simple RMS energy as placeholder for real VAD inference
    const view = new Int16Array(audio.buffer, audio.byteOffset, audio.length / 2);
    let sum = 0;
    for (let i = 0; i < view.length; i++) {
      sum += (view[i]! / 32768) ** 2;
    }
    return Math.sqrt(sum / view.length);
  }

  async close(): Promise<void> {
    this.bus = null;
  }
}
