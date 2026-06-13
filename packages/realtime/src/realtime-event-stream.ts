// SPDX-License-Identifier: MIT

import type { RealtimeEvent } from "./realtime-adapter.js";

/**
 * Single-consumer async-iterable queue of realtime provider events. Producers call
 * `push()` / `close()`; the consumer drains it with `for await`. Events queue until
 * consumed (no backpressure). Shared by every realtime adapter so the iteration and
 * close semantics cannot drift between providers.
 */
export class RealtimeEventStream implements AsyncIterable<RealtimeEvent> {
  private readonly queue: RealtimeEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<RealtimeEvent>) => void> = [];
  private closed = false;

  push(event: RealtimeEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: event, done: false });
      return;
    }
    this.queue.push(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<RealtimeEvent> {
    return {
      next: () =>
        new Promise<IteratorResult<RealtimeEvent>>((resolve) => {
          if (this.queue.length > 0) {
            resolve({ value: this.queue.shift()!, done: false });
            return;
          }
          if (this.closed) {
            resolve({ value: undefined, done: true });
            return;
          }
          this.waiters.push(resolve);
        }),
    };
  }
}
