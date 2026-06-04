// SPDX-License-Identifier: MIT

export type ScheduledCallback = () => void | Promise<void>;

export interface Scheduler {
  schedule(key: string, delayMs: number, cb: ScheduledCallback): void;
  cancel(key: string): void;
}

export class TimerScheduler implements Scheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  schedule(key: string, delayMs: number, cb: ScheduledCallback): void {
    this.cancel(key);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void cb();
    }, Math.max(0, delayMs));
    this.timers.set(key, timer);
  }

  cancel(key: string): void {
    const timer = this.timers.get(key);
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(key);
  }
}
