// SPDX-License-Identifier: MIT

export interface PacedPlayoutFrame {
  readonly send: () => void | boolean;
  readonly afterSend?: () => void;
}

interface QueuedPlayoutFrame extends PacedPlayoutFrame {
  readonly durationMs: number;
}

export class PacedPlayoutQueue {
  private readonly frames: QueuedPlayoutFrame[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pumping = false;
  private queuedDurationMs = 0;
  private closed = false;

  constructor(
    private readonly frameDurationMs: number,
    private readonly maxQueuedDurationMs: number,
    private readonly onOverflow: (discardedDurationMs: number) => void,
    private readonly onSendFailure: (discardedDurationMs: number) => void = () => undefined,
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

  enqueueControl(send: () => void | boolean): void {
    if (this.closed) return;
    if (this.frames.length === 0 && this.timer === null && !this.pumping) {
      send();
      return;
    }
    this.frames.push({ send, durationMs: 0 });
    this.maybePump();
  }

  clear(): number {
    const removedAudioDurationMs = this.queuedDurationMs;
    this.frames.length = 0;
    this.queuedDurationMs = 0;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
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
    this.queuedDurationMs = Math.max(0, this.queuedDurationMs - frame.durationMs);
    const sent = frame.send();
    if (sent === false) {
      const discardedDurationMs = frame.durationMs + this.clear();
      this.pumping = false;
      this.onSendFailure(discardedDurationMs);
      return;
    }
    frame.afterSend?.();
    this.pumping = false;
    if (this.frames.length > 0) {
      this.timer = setTimeout(() => this.pump(), this.frameDurationMs);
    }
  }
}
