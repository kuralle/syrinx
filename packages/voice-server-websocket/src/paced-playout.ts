// SPDX-License-Identifier: MIT

export interface PacedPlayoutFrame {
  readonly send: () => void | boolean;
  readonly afterSend?: () => void;
  /** Context this frame belongs to, for realtime playout-position reporting. */
  readonly contextId?: string;
  /**
   * When `false`, this frame survives a barge-in `clearInterruptible()`. Audio frames
   * are always interruptible (left undefined), so speech is never replayed after an interrupt.
   */
  readonly interruptible?: boolean;
}

interface QueuedPlayoutFrame extends PacedPlayoutFrame {
  readonly durationMs: number;
}

const DEADLINE_MISS_TOLERANCE_MS = 5;

export class PacedPlayoutQueue {
  private readonly frames: QueuedPlayoutFrame[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pumping = false;
  private queuedDurationMs = 0;
  private closed = false;
  private nextDeadlineMs = 0;

  constructor(
    private readonly frameDurationMs: number,
    private readonly maxQueuedDurationMs: number,
    private readonly onOverflow: (discardedDurationMs: number) => void,
    private readonly onSendFailure: (discardedDurationMs: number) => void = () => undefined,
    private readonly onDeadlineMiss: (lateMs: number) => void = () => undefined,
    // Fires after each audio frame is paced to the wire — the realtime playout
    // clock. durationMs is the frame's realtime length; contextId tags the turn.
    private readonly onFramePlayed: (contextId: string | undefined, durationMs: number) => void = () => undefined,
  ) {}

  enqueue(frames: readonly PacedPlayoutFrame[]): boolean {
    if (this.closed || frames.length === 0) return !this.closed;
    const additionalDurationMs = frames.length * this.frameDurationMs;
    if (this.queuedDurationMs + additionalDurationMs > this.maxQueuedDurationMs) {
      const discardedDurationMs = this.clear();
      this.onOverflow(discardedDurationMs);
      return false;
    }
    this.frames.push(...frames.map((frame) => ({ ...frame, durationMs: this.frameDurationMs })));
    this.queuedDurationMs += additionalDurationMs;
    this.maybePump();
    return true;
  }

  enqueueControl(send: () => void | boolean, opts?: { uninterruptible?: boolean }): void {
    if (this.closed) return;
    if (this.frames.length === 0 && this.timer === null && !this.pumping) {
      send();
      return;
    }
    this.frames.push({ send, durationMs: 0, interruptible: opts?.uninterruptible ? false : undefined });
    this.maybePump();
  }

  clear(): number {
    const removedAudioDurationMs = this.queuedDurationMs;
    this.frames.length = 0;
    this.queuedDurationMs = 0;
    this.nextDeadlineMs = 0;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return removedAudioDurationMs;
  }

  /**
   * Barge-in clear: drop interruptible frames (all audio + unmarked control frames),
   * retaining frames enqueued as uninterruptible. Audio frames are always interruptible,
   * so speech is never replayed. Returns the discarded audio duration in ms. With nothing
   * marked uninterruptible this is equivalent to `clear()`.
   */
  clearInterruptible(): number {
    const retained: QueuedPlayoutFrame[] = [];
    let removedAudioDurationMs = 0;
    for (const frame of this.frames) {
      if (frame.interruptible === false) {
        retained.push(frame);
      } else {
        removedAudioDurationMs += frame.durationMs;
      }
    }
    this.frames.length = 0;
    this.frames.push(...retained);
    this.queuedDurationMs = retained.reduce((sum, frame) => sum + frame.durationMs, 0);
    this.nextDeadlineMs = 0;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.frames.length > 0) this.maybePump();
    return removedAudioDurationMs;
  }

  close(): void {
    this.closed = true;
    this.clear();
  }

  private maybePump(): void {
    if (this.pumping || this.timer || this.frames.length === 0) return;
    this.pump();
  }

  private pump(): void {
    if (this.closed) return;
    this.timer = null;
    const frame = this.frames.shift();
    if (!frame) return;
    this.pumping = true;
    const now = Date.now();

    // On the first frame after a clear/start, establish the deadline baseline.
    if (this.nextDeadlineMs === 0) {
      this.nextDeadlineMs = now;
    } else if (now - this.nextDeadlineMs > DEADLINE_MISS_TOLERANCE_MS) {
      this.onDeadlineMiss(now - this.nextDeadlineMs);
    }

    this.queuedDurationMs = Math.max(0, this.queuedDurationMs - frame.durationMs);
    const sent = frame.send();
    if (sent === false) {
      const discardedDurationMs = frame.durationMs + this.clear();
      this.pumping = false;
      this.onSendFailure(discardedDurationMs);
      return;
    }
    frame.afterSend?.();
    if (frame.durationMs > 0) this.onFramePlayed(frame.contextId, frame.durationMs);
    this.pumping = false;
    if (this.frames.length > 0) {
      this.nextDeadlineMs += frame.durationMs;
      const delay = Math.max(0, this.nextDeadlineMs - Date.now());
      this.timer = setTimeout(() => this.pump(), delay);
    } else {
      // Queue drained on a natural inter-sentence gap (no clear() — clear() only
      // runs on overflow/send-failure/interrupt). Re-baseline so the next burst's
      // first frame doesn't read the stale deadline as a huge spurious miss.
      this.nextDeadlineMs = 0;
    }
  }
}
