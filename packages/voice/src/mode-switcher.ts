// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Mode Switcher
//
// Handles text ↔ audio mode transitions mid-session.
// Text→Audio: serial init of audio pipeline (STT, TTS, VAD, EOS, Denoiser)
// Audio→Text: confirm text mode immediately, teardown audio components in background
//
// Design decision: audio→text confirms immediately so the user can send text
// without waiting for STT/TTS/VAD/EOS WebSocket connections to close.

import type { PipelineBus } from "./pipeline-bus.js";
import { Route } from "./pipeline-bus.js";
import type {
  ModeSwitchRequestedPacket,
  ModeSwitchCompletedPacket,
} from "./packets.js";
import { runInitChain, type InitStep as InitStepType } from "./init-chain.js";

// =============================================================================
// Types
// =============================================================================

export interface ModeSwitchHandlers {
  /** Steps to run when switching from text to audio mode. */
  textToAudioSteps: InitStepType[];
  /** Steps to run when switching from audio to text mode (teardown). */
  audioToTextCleanups: Array<() => Promise<void>>;
}

// =============================================================================
// Switcher
// =============================================================================

export class ModeSwitcher {
  private currentMode: "text" | "audio";
  private readonly bus: PipelineBus;
  private handlers: ModeSwitchHandlers | null = null;

  constructor(bus: PipelineBus, initialMode: "text" | "audio" = "audio") {
    this.bus = bus;
    this.currentMode = initialMode;
  }

  /** Register the init/teardown steps. Call once during session setup. */
  register(handlers: ModeSwitchHandlers): void {
    this.handlers = handlers;
  }

  /** Get the current mode. */
  get mode(): "text" | "audio" {
    return this.currentMode;
  }

  /** Handle a mode switch request from the bus. */
  async handleSwitchRequested(pkt: ModeSwitchRequestedPacket): Promise<void> {
    if (pkt.mode === this.currentMode) return;
    if (!this.handlers) return;

    if (pkt.mode === "audio") {
      await this.switchToAudio(pkt.contextId);
    } else {
      await this.switchToText(pkt.contextId);
    }
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async switchToAudio(contextId: string): Promise<void> {
    if (!this.handlers) return;

    try {
      await runInitChain(this.bus, this.handlers.textToAudioSteps);
      this.currentMode = "audio";

      const completed: ModeSwitchCompletedPacket = {
        kind: "mode.switch_completed",
        contextId,
        timestampMs: Date.now(),
        mode: "audio",
      };
      this.bus.push(Route.Main, completed);
    } catch (err) {
      // Init chain already emitted init.failed — re-throw for session handler
      throw err;
    }
  }

  private async switchToText(contextId: string): Promise<void> {
    // Confirm text mode immediately — don't wait for teardown
    this.currentMode = "text";

    const completed: ModeSwitchCompletedPacket = {
      kind: "mode.switch_completed",
      contextId,
      timestampMs: Date.now(),
      mode: "text",
    };
    this.bus.push(Route.Main, completed);

    // Teardown audio components in background
    if (this.handlers?.audioToTextCleanups) {
      void Promise.allSettled(
        this.handlers.audioToTextCleanups.map((fn) => fn()),
      );
    }
  }
}
