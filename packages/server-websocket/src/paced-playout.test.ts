// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PacedPlayoutQueue, type PacedPlayoutFrame } from "./paced-playout.js";

function makeFrame(onSend?: () => void): PacedPlayoutFrame {
  return { send: () => { onSend?.(); } };
}

describe("PacedPlayoutQueue — drift-corrected scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("drift-locked cadence: second frame fires at T+FRAME_MS despite slow first send", () => {
    vi.setSystemTime(0);
    const FRAME_MS = 20;
    const sendTimes: number[] = [];

    const queue = new PacedPlayoutQueue(FRAME_MS, 10_000, () => {});

    // First send() runs outside tick() context (maybePump → pump is called
    // synchronously from enqueue). Safe to call setSystemTime here.
    // Simulates 8ms of work, so without drift-correction the second timer
    // would be scheduled at callAt = 0+8+20 = 28 instead of 20.
    queue.enqueue([
      {
        send: () => {
          sendTimes.push(Date.now());
          vi.setSystemTime(8);
        },
      },
      { send: () => { sendTimes.push(Date.now()); } },
    ]);

    // With drift-correction: delay = max(0, 20 - 8) = 12, callAt = 8+12 = 20
    // Without drift-correction: delay = 20, callAt = 8+20 = 28
    vi.advanceTimersByTime(20); // covers [8, 28] — fires callAt=20 but NOT callAt=28

    expect(sendTimes).toHaveLength(2);
    expect(sendTimes[0]).toBe(0);
    expect(sendTimes[1]).toBe(20); // wall-clock-locked
  });

  it("fires onDeadlineMiss with correct lateMs when pump wakes up past tolerance", () => {
    vi.setSystemTime(0);
    const FRAME_MS = 20;
    const misses: number[] = [];

    const queue = new PacedPlayoutQueue(
      FRAME_MS,
      10_000,
      () => {},
      () => {},
      (lateMs) => misses.push(lateMs),
    );

    // First send() advances the clock to 30ms (past the T+20 next deadline).
    // This causes the next timer to be scheduled with delay=0, callAt=30.
    // When that timer fires, now=30 and nextDeadlineMs=20, so lateMs=10 > 5.
    queue.enqueue([
      {
        send: () => {
          vi.setSystemTime(30);
        },
      },
      makeFrame(),
    ]);

    vi.advanceTimersByTime(1); // fire the 0ms timer (callAt=30, advances 30→31)

    expect(misses).toHaveLength(1);
    expect(misses[0]).toBe(10); // 30 - 20 = 10ms late
  });

  it("does NOT fire onDeadlineMiss when pump fires on time (within tolerance)", () => {
    vi.setSystemTime(0);
    const FRAME_MS = 20;
    const misses: number[] = [];

    const queue = new PacedPlayoutQueue(
      FRAME_MS,
      10_000,
      () => {},
      () => {},
      (lateMs) => misses.push(lateMs),
    );

    queue.enqueue([makeFrame(), makeFrame(), makeFrame()]);

    // Exact FRAME_MS advances — timers fire precisely on their deadlines.
    vi.advanceTimersByTime(FRAME_MS);
    vi.advanceTimersByTime(FRAME_MS);

    expect(misses).toHaveLength(0);
  });

  it("resets deadline tracking after clear() so next burst starts fresh with no spurious misses", () => {
    vi.setSystemTime(0);
    const FRAME_MS = 20;
    const misses: number[] = [];

    const queue = new PacedPlayoutQueue(
      FRAME_MS,
      10_000,
      () => {},
      () => {},
      (lateMs) => misses.push(lateMs),
    );

    queue.enqueue([makeFrame(), makeFrame()]);
    vi.advanceTimersByTime(FRAME_MS);
    queue.clear();

    // Simulate a 5 s inter-utterance gap. Without clear() resetting the
    // deadline, the next frame would appear ~5000ms late and trigger a miss.
    vi.advanceTimersByTime(5_000);

    // New burst with no simulated send overhead.
    queue.enqueue([makeFrame(), makeFrame()]);

    vi.advanceTimersByTime(FRAME_MS);

    // The first frame of a new burst sets the baseline (nextDeadlineMs was 0),
    // and the second frame fires on schedule — neither should miss.
    expect(misses).toHaveLength(0);
  });

  it("re-baselines after a natural drain (no clear) so an inter-sentence gap is not a false miss", () => {
    vi.setSystemTime(0);
    const FRAME_MS = 20;
    const misses: number[] = [];

    const queue = new PacedPlayoutQueue(
      FRAME_MS,
      10_000,
      () => {},
      () => {},
      (lateMs) => misses.push(lateMs),
    );

    // First burst of two frames drains naturally — the queue empties with NO
    // clear() call (clear() only runs on overflow/send-failure/interrupt).
    queue.enqueue([makeFrame(), makeFrame()]);
    vi.advanceTimersByTime(FRAME_MS);

    // Natural inter-sentence gap: no audio, no clear().
    vi.advanceTimersByTime(2_000);

    // Next burst. Its first frame must re-baseline rather than read the stale
    // pre-gap deadline as a ~2000ms miss.
    queue.enqueue([makeFrame(), makeFrame()]);
    vi.advanceTimersByTime(FRAME_MS);

    expect(misses).toHaveLength(0);
  });

  it("does not advance the playout deadline by frameDurationMs after a 0 ms control frame", () => {
    const FRAME_MS = 20;
    let sends = 0;
    const misses: number[] = [];

    const queue = new PacedPlayoutQueue(
      FRAME_MS,
      10_000,
      () => {},
      () => {},
      (lateMs) => misses.push(lateMs),
    );

    queue.enqueue([{ send: () => { sends += 1; } }]);
    expect(sends).toBe(1);
    queue.enqueueControl(() => { sends += 1; });
    queue.enqueue([{ send: () => { sends += 1; } }]);
    vi.advanceTimersByTime(FRAME_MS);
    expect(sends).toBe(3);
    vi.advanceTimersByTime(FRAME_MS);
    expect(sends).toBe(3);
    expect(misses).toHaveLength(0);
  });

  it("backward-compatible: works without onDeadlineMiss callback", () => {
    const queue = new PacedPlayoutQueue(20, 10_000, () => {});
    expect(() => {
      queue.enqueue([makeFrame(), makeFrame()]);
      vi.advanceTimersByTime(40);
    }).not.toThrow();
  });

  it("clearInterruptible drops audio but retains an uninterruptible control frame", () => {
    const FRAME_MS = 20;
    const sends: string[] = [];
    const queue = new PacedPlayoutQueue(FRAME_MS, 10_000, () => {});

    // a1 sends synchronously on enqueue; a2 + a3 remain queued behind the pacer timer.
    queue.enqueue([
      { send: () => { sends.push("a1"); } },
      { send: () => { sends.push("a2"); } },
      { send: () => { sends.push("a3"); } },
    ]);
    expect(sends).toEqual(["a1"]);

    queue.enqueueControl(() => { sends.push("ctrl"); }, { uninterruptible: true });

    const discarded = queue.clearInterruptible();

    // a2 + a3 (interruptible audio) dropped; the uninterruptible control survives and is pumped.
    expect(discarded).toBe(2 * FRAME_MS);
    expect(sends).toEqual(["a1", "ctrl"]);

    // No dropped audio is ever replayed on later ticks.
    vi.advanceTimersByTime(FRAME_MS * 5);
    expect(sends).toEqual(["a1", "ctrl"]);
  });

  it("clearInterruptible never replays dropped audio frames", () => {
    const FRAME_MS = 20;
    const sends: string[] = [];
    const queue = new PacedPlayoutQueue(FRAME_MS, 10_000, () => {});
    queue.enqueue([
      { send: () => { sends.push("a1"); } },
      { send: () => { sends.push("a2"); } },
      { send: () => { sends.push("a3"); } },
    ]);
    queue.clearInterruptible();
    vi.advanceTimersByTime(FRAME_MS * 5);
    expect(sends).toEqual(["a1"]); // a2/a3 never sent — no speech replay after interrupt
  });

  it("clearInterruptible drops unmarked control frames (back-compat with clear)", () => {
    const FRAME_MS = 20;
    const sends: string[] = [];
    const queue = new PacedPlayoutQueue(FRAME_MS, 10_000, () => {});
    queue.enqueue([
      { send: () => { sends.push("a1"); } },
      { send: () => { sends.push("a2"); } },
    ]);
    queue.enqueueControl(() => { sends.push("ctrl"); }); // default = interruptible
    queue.clearInterruptible();
    vi.advanceTimersByTime(FRAME_MS * 5);
    expect(sends).toEqual(["a1"]); // a2 + unmarked control both dropped
  });
});
