// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Idle Timeout Manager
//
// Tracks user silence and escalates: inject message → inject warning → disconnect.
// Configurable duration, escalation messages, and consecutive backoff.
//
// Design decision (per RFC Q4 resolution): idle messages are injected as
// synthetic LlmDeltaPacket + LlmDonePacket through the normal TTS path.
// This keeps voice style, logging, interruption, and abort semantics consistent.

import type { PipelineBus } from "./pipeline-bus.js";
import { Route } from "./pipeline-bus.js";
import type {
  StartIdleTimeoutPacket,
  StopIdleTimeoutPacket,
  InjectMessagePacket,
  DisconnectRequestedPacket,
} from "./packets.js";
import { TimerScheduler, type Scheduler } from "./scheduler.js";

// =============================================================================
// Configuration
// =============================================================================

export interface IdleTimeoutConfig {
  /** Base duration before triggering idle behavior (ms). Default: 15000 */
  durationMs: number;
  /**
   * Number of consecutive timeouts before disconnecting.
   * 0 = never disconnect (just inject messages repeatedly).
   * Default: 3
   */
  maxConsecutive: number;
  /**
   * Messages to inject at each consecutive idle.
   * Index 0 = first timeout, index 1 = second timeout, etc.
   * If more timeouts occur than messages, the last message repeats.
   * Default: ["Are you still there?", "I'll end this call soon."]
   */
  escalationMessages: string[];
  /**
   * Whether to disconnect the session after maxConsecutive is reached.
   * If false, the maxConsecutive counter stops incrementing and the
   * last escalation message repeats indefinitely.
   * Default: true
   */
  disconnectAfterMax: boolean;
}

export const DEFAULT_IDLE_TIMEOUT_CONFIG: IdleTimeoutConfig = {
  durationMs: 15_000,
  maxConsecutive: 3,
  escalationMessages: ["Are you still there?", "I'll end this call soon."],
  disconnectAfterMax: true,
};

// =============================================================================
// Manager
// =============================================================================

export class IdleTimeoutManager {
  private timerScheduled = false;
  private count = 0;
  private readonly config: IdleTimeoutConfig;
  private readonly bus: PipelineBus;
  private currentContextId: string;
  private readonly scheduler: Scheduler;

  constructor(
    bus: PipelineBus,
    config?: Partial<IdleTimeoutConfig>,
    scheduler?: Scheduler,
  ) {
    this.bus = bus;
    this.config = { ...DEFAULT_IDLE_TIMEOUT_CONFIG, ...config };
    this.currentContextId = "";
    this.scheduler = scheduler ?? new TimerScheduler();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Set the current turn context ID (used for injected message context). */
  setContextId(id: string): void {
    this.currentContextId = id;
  }

  /** Start (or restart) the idle timeout timer. */
  start(): void {
    this.clearTimer();
    if (this.config.durationMs <= 0) return;

    this.timerScheduled = true;
    this.scheduler.schedule("voice.idle_timeout", this.config.durationMs, () => {
      this.timerScheduled = false;
      this.onTimeout();
    });
  }

  /**
   * Stop the idle timeout timer.
   * @param resetCount — If true, resets the consecutive idle counter.
   *   Use true when the user actively engages (speaks or types).
   *   Use false for system-driven stops (e.g., TTS still playing).
   */
  stop(resetCount: boolean): void {
    this.clearTimer();
    if (resetCount) {
      this.count = 0;
    }
  }

  /**
   * Extend the current timer by a duration (e.g., TTS audio playback time).
   * Stops the current timer and restarts with the remaining time + extension.
   */
  extend(ms: number): void {
    this.clearTimer();
    this.timerScheduled = true;
    this.scheduler.schedule("voice.idle_timeout", this.config.durationMs + ms, () => {
      this.timerScheduled = false;
      this.onTimeout();
    });
  }

  /** Clean up — stop timer without side effects. */
  dispose(): void {
    this.clearTimer();
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private clearTimer(): void {
    if (!this.timerScheduled) return;
    this.scheduler.cancel("voice.idle_timeout");
    this.timerScheduled = false;
  }

  private onTimeout(): void {
    this.count++;

    // Check if we should disconnect
    if (
      this.config.maxConsecutive > 0 &&
      this.count >= this.config.maxConsecutive &&
      this.config.disconnectAfterMax
    ) {
      const disconnect: DisconnectRequestedPacket = {
        kind: "session.disconnect",
        contextId: this.currentContextId,
        timestampMs: Date.now(),
        reason: `idle_timeout: ${this.count} consecutive`,
      };
      this.bus.push(Route.Critical, disconnect);
      return;
    }

    // Inject escalation message
    const msgIdx = Math.min(
      this.count - 1,
      this.config.escalationMessages.length - 1,
    );
    const message = this.config.escalationMessages[msgIdx];
    if (message) {
      const inject: InjectMessagePacket = {
        kind: "inject.message",
        contextId: this.currentContextId,
        timestampMs: Date.now(),
        text: message,
      };
      this.bus.push(Route.Main, inject);
    }

    // Restart timer for next escalation
    this.start();
  }

  // -------------------------------------------------------------------------
  // Bus packet handlers (for integration with VoiceAgentSession)
  // -------------------------------------------------------------------------

  /** Handle a StartIdleTimeoutPacket from the bus. */
  handleStart(pkt: StartIdleTimeoutPacket): void {
    if (pkt.contextId) this.setContextId(pkt.contextId);
    this.start();
  }

  /** Handle a StopIdleTimeoutPacket from the bus. */
  handleStop(pkt: StopIdleTimeoutPacket): void {
    this.stop(pkt.resetCount);
  }
}
