// SPDX-License-Identifier: MIT

import { Route, type PipelineBus } from "@kuralle-syrinx/core";

const PROGRESS_THROTTLE_MS = 200;

/**
 * Tracks realtime playout position per context for one connection and emits
 * `tts.playout_progress` as paced audio reaches the wire. This makes the output
 * transport the authoritative playout clock that the engine's turn-taking (and,
 * later, recording) consume — instead of reconstructing timing from TTS
 * generation arrival, which is provider-stream-rate dependent.
 *
 * - `onFramePlayed` is wired to the PacedPlayoutQueue and called per frame; it
 *   accumulates and emits throttled progress.
 * - `complete` is called from the transport's end-of-context drain (the control
 *   frame that runs after all audio has been paced out) and is authoritative.
 * - `discard` drops a context on interrupt/clear without emitting completion.
 */
export class PlayoutProgressEmitter {
  private readonly playedOutMs = new Map<string, number>();
  private readonly lastEmittedMs = new Map<string, number>();
  private readonly playoutStarted = new Set<string>();

  constructor(private readonly bus: PipelineBus) {}

  onFramePlayed = (contextId: string | undefined, durationMs: number): void => {
    if (contextId === undefined || durationMs <= 0) return;
    if (!this.playoutStarted.has(contextId)) {
      this.playoutStarted.add(contextId);
      this.bus.push(Route.Main, {
        kind: "tts.playout_started",
        contextId,
        timestampMs: Date.now(),
      });
    }
    const total = (this.playedOutMs.get(contextId) ?? 0) + durationMs;
    this.playedOutMs.set(contextId, total);
    const lastEmitted = this.lastEmittedMs.get(contextId) ?? 0;
    if (total - lastEmitted >= PROGRESS_THROTTLE_MS) {
      this.lastEmittedMs.set(contextId, total);
      this.emit(contextId, total, false);
    }
  };

  complete(contextId: string): void {
    const total = this.playedOutMs.get(contextId) ?? 0;
    this.discard(contextId);
    this.emit(contextId, total, true);
  }

  discard(contextId: string): void {
    this.playedOutMs.delete(contextId);
    this.lastEmittedMs.delete(contextId);
    this.playoutStarted.delete(contextId);
  }

  private emit(contextId: string, playedOutMs: number, complete: boolean): void {
    this.bus.push(Route.Main, {
      kind: "tts.playout_progress",
      contextId,
      timestampMs: Date.now(),
      playedOutMs,
      complete,
    });
  }
}
