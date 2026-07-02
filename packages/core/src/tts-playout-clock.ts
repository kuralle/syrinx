// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — TTS Playout Clock
//
// Tracks when each context's streamed TTS audio finishes *playing out* (not just
// generating). TTS streams faster than realtime, so generation (tts.end) ends
// well before playout; turn-taking keys on these estimates so the assistant
// stays interruptible until it is actually done being heard.
//
// Pure state + timers — no bus, no other session coupling. The orchestrator owns
// wiring; this owns the playout bookkeeping.

import { TimerScheduler, type Scheduler } from "./scheduler.js";

export class TtsPlayoutClock {
  private readonly active = new Set<string>();
  // Wall-clock estimate of when each context's audio finishes playing out.
  private readonly playoutEndMs = new Map<string, number>();
  private readonly releaseTimers = new Set<string>();
  // Contexts for which the output transport has reported real playout progress.
  // When present, the transport's `complete` signal is authoritative and the
  // sample-duration estimate defers to it (it is only a fallback for transports
  // without a paced-playout layer, e.g. headless).
  private readonly realPlayoutContexts = new Set<string>();
  private readonly playedOutMsByContext = new Map<string, number>();

  constructor(private readonly scheduler: Scheduler = new TimerScheduler()) {}

  /**
   * A TTS audio chunk arrived: mark the context active and advance its playout
   * cursor by the chunk's realtime duration, anchored to `nowMs` if the previous
   * estimate already lapsed (a gap in delivery).
   */
  noteAudio(contextId: string, audioDurationMs: number, nowMs: number): void {
    this.cancelRelease(contextId);
    this.active.add(contextId);
    const base = Math.max(nowMs, this.playoutEndMs.get(contextId) ?? nowMs);
    this.playoutEndMs.set(contextId, base + audioDurationMs);
  }

  /**
   * Generation finished (tts.end). Keep the context interruptible until its
   * playout estimate elapses, then release it. Releases immediately if the
   * estimate has already passed.
   */
  scheduleRelease(contextId: string, nowMs: number): void {
    const playoutEndMs = this.playoutEndMs.get(contextId);
    const remainingMs = playoutEndMs === undefined ? 0 : playoutEndMs - nowMs;
    if (remainingMs <= 0) {
      this.release(contextId);
      return;
    }
    this.cancelRelease(contextId);
    this.releaseTimers.add(contextId);
    this.scheduler.schedule(releaseKey(contextId), remainingMs, () => {
      this.releaseTimers.delete(contextId);
      // If a paced transport is reporting real playout for this context, it
      // owns the release via noteProgress({complete}) — the estimate must not
      // pre-empt it (real playout can run past the audio length under
      // send-buffer backpressure). Session close() is the backstop.
      if (this.realPlayoutContexts.has(contextId)) return;
      this.release(contextId);
    });
  }

  /**
   * Transport reported realtime playout progress for a context. Real playout is
   * authoritative once seen; release the context when it reports complete.
   */
  noteProgress(contextId: string, complete: boolean, playedOutMs?: number): void {
    this.realPlayoutContexts.add(contextId);
    if (playedOutMs !== undefined) this.playedOutMsByContext.set(contextId, playedOutMs);
    if (complete) this.release(contextId);
  }

  positionMs(contextId: string): number | undefined {
    return this.playedOutMsByContext.get(contextId);
  }

  release(contextId: string): void {
    this.cancelRelease(contextId);
    this.active.delete(contextId);
    this.playoutEndMs.delete(contextId);
    this.realPlayoutContexts.delete(contextId);
    this.playedOutMsByContext.delete(contextId);
  }

  isActive(contextId: string): boolean {
    return this.active.has(contextId);
  }

  /** All still-active contexts, insertion order (oldest first). */
  activeContexts(): string[] {
    return [...this.active];
  }

  /**
   * Wall-clock estimate of when this context's audio finishes playing out, or
   * undefined if unknown. Anchors the idle timer to real playout end rather than
   * chunk-arrival (TTS streams faster than realtime).
   */
  playoutEnd(contextId: string): number | undefined {
    return this.playoutEndMs.get(contextId);
  }

  /** The most-recently-added still-active context (insertion order), or "" if none. */
  latestActive(): string {
    let latest = "";
    for (const contextId of this.active) latest = contextId;
    return latest;
  }

  clear(): void {
    for (const contextId of [...this.releaseTimers]) this.cancelRelease(contextId);
    this.active.clear();
    this.playoutEndMs.clear();
    this.realPlayoutContexts.clear();
    this.playedOutMsByContext.clear();
  }

  private cancelRelease(contextId: string): void {
    if (!this.releaseTimers.has(contextId)) return;
    this.scheduler.cancel(releaseKey(contextId));
    this.releaseTimers.delete(contextId);
  }
}

function releaseKey(contextId: string): string {
  return `voice.tts_playout.release:${contextId}`;
}
