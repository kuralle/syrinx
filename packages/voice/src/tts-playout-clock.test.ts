// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TtsPlayoutClock } from "./tts-playout-clock.js";

describe("TtsPlayoutClock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks a context active on the first audio chunk", () => {
    const clock = new TtsPlayoutClock();
    expect(clock.isActive("c1")).toBe(false);
    clock.noteAudio("c1", 100, Date.now());
    expect(clock.isActive("c1")).toBe(true);
    expect(clock.latestActive()).toBe("c1");
  });

  it("keeps a context interruptible until its playout estimate elapses, then releases", () => {
    const clock = new TtsPlayoutClock();
    clock.noteAudio("c1", 200, Date.now()); // playout ends at t=200
    clock.scheduleRelease("c1", Date.now()); // 200ms remaining
    expect(clock.isActive("c1")).toBe(true);
    vi.advanceTimersByTime(199);
    expect(clock.isActive("c1")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(clock.isActive("c1")).toBe(false);
  });

  it("releases immediately when the playout estimate has already passed", () => {
    const clock = new TtsPlayoutClock();
    clock.noteAudio("c1", 50, Date.now());
    vi.setSystemTime(100); // well past the 50ms estimate
    clock.scheduleRelease("c1", Date.now());
    expect(clock.isActive("c1")).toBe(false);
  });

  it("lets real transport playout override the estimate: the timer must not pre-empt", () => {
    const clock = new TtsPlayoutClock();
    clock.noteAudio("c1", 100, Date.now());
    clock.scheduleRelease("c1", Date.now()); // estimate release at t=100
    clock.noteProgress("c1", false); // transport now authoritative, not yet complete
    vi.advanceTimersByTime(500); // estimate timer fires but must defer
    expect(clock.isActive("c1")).toBe(true);
    clock.noteProgress("c1", true); // transport says done
    expect(clock.isActive("c1")).toBe(false);
  });

  it("advances the playout cursor across chunks instead of resetting it", () => {
    const clock = new TtsPlayoutClock();
    clock.noteAudio("c1", 100, Date.now()); // ends at 100
    clock.noteAudio("c1", 100, Date.now()); // still t=0, extends to 200
    clock.scheduleRelease("c1", Date.now());
    vi.advanceTimersByTime(150);
    expect(clock.isActive("c1")).toBe(true); // would have released at 100 if reset
    vi.advanceTimersByTime(50);
    expect(clock.isActive("c1")).toBe(false);
  });

  it("reports the most-recently-added active context as latest", () => {
    const clock = new TtsPlayoutClock();
    clock.noteAudio("a", 10, Date.now());
    clock.noteAudio("b", 10, Date.now());
    expect(clock.latestActive()).toBe("b");
    clock.release("b");
    expect(clock.latestActive()).toBe("a");
    clock.release("a");
    expect(clock.latestActive()).toBe("");
  });

  it("records playout position and returns it via positionMs", () => {
    const clock = new TtsPlayoutClock();
    expect(clock.positionMs("c1")).toBeUndefined();
    clock.noteAudio("c1", 100, Date.now());
    clock.noteProgress("c1", false, 42);
    expect(clock.positionMs("c1")).toBe(42);
  });

  it("keeps the latest playout position across multiple progress updates", () => {
    const clock = new TtsPlayoutClock();
    clock.noteAudio("c1", 100, Date.now());
    clock.noteProgress("c1", false, 10);
    clock.noteProgress("c1", false, 55);
    expect(clock.positionMs("c1")).toBe(55);
  });

  it("drops recorded position on release and clear", () => {
    const clock = new TtsPlayoutClock();
    clock.noteAudio("c1", 100, Date.now());
    clock.noteProgress("c1", false, 30);
    clock.release("c1");
    expect(clock.positionMs("c1")).toBeUndefined();

    clock.noteAudio("c2", 100, Date.now());
    clock.noteProgress("c2", false, 20);
    clock.clear();
    expect(clock.positionMs("c2")).toBeUndefined();
  });

  it("noteProgress without position still releases on complete", () => {
    const clock = new TtsPlayoutClock();
    clock.noteAudio("c1", 100, Date.now());
    clock.noteProgress("c1", false);
    expect(clock.positionMs("c1")).toBeUndefined();
    expect(clock.isActive("c1")).toBe(true);
    clock.noteProgress("c1", true);
    expect(clock.isActive("c1")).toBe(false);
    expect(clock.positionMs("c1")).toBeUndefined();
  });

  it("clear() drops all state and cancels pending release timers", () => {
    const clock = new TtsPlayoutClock();
    clock.noteAudio("c1", 100, Date.now());
    clock.scheduleRelease("c1", Date.now());
    clock.clear();
    expect(clock.isActive("c1")).toBe(false);
    // A leaked timer would throw "release of cleared context" — assert none fire.
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(clock.latestActive()).toBe("");
  });
});
