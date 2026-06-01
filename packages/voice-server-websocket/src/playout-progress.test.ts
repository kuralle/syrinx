// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { PipelineBusImpl } from "@asyncdot/voice";
import { PlayoutProgressEmitter } from "./playout-progress.js";

async function withRunningBus(fn: (bus: PipelineBusImpl) => void | Promise<void>): Promise<void> {
  const bus = new PipelineBusImpl();
  const startP = bus.start();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await fn(bus);
  await new Promise((resolve) => setTimeout(resolve, 5));
  bus.stop();
  await startP;
}

describe("PlayoutProgressEmitter", () => {
  it("emits playout_started on the first paced audio frame and throttles progress", async () => {
    const startedAt: number[] = [];
    const progress: number[] = [];

    await withRunningBus((bus) => {
      bus.on("tts.playout_started", (pkt) => {
        startedAt.push((pkt as { timestampMs: number }).timestampMs);
      });
      bus.on("tts.playout_progress", (pkt) => {
        progress.push((pkt as unknown as { playedOutMs: number }).playedOutMs);
      });

      const emitter = new PlayoutProgressEmitter(bus);
      emitter.onFramePlayed("turn-a", 20);
      emitter.onFramePlayed("turn-a", 20);
      emitter.onFramePlayed("turn-a", 200);
    });

    expect(startedAt).toHaveLength(1);
    expect(progress).toEqual([240]);
  });

  it("re-emits playout_started after discard resets context tracking", async () => {
    let startedCount = 0;

    await withRunningBus((bus) => {
      bus.on("tts.playout_started", () => {
        startedCount += 1;
      });

      const emitter = new PlayoutProgressEmitter(bus);
      emitter.onFramePlayed("turn-a", 20);
      emitter.discard("turn-a");
      emitter.onFramePlayed("turn-a", 20);
    });

    expect(startedCount).toBe(2);
  });
});
