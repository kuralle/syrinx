// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { PipelineBusImpl, Route, type InjectMessagePacket } from "@kuralle-syrinx/core";
import { UniversitySupportObserver, type ObserverTurn } from "./university-support-observer.js";

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1000) throw new Error("Timed out waiting for observer");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function turn(contextId: string, text: string): ObserverTurn {
  return { contextId, text };
}

describe("UniversitySupportObserver", () => {
  it("evaluates one turn at a time, drains the pending slot, and deduplicates corrections", async () => {
    const evaluations: ObserverTurn[] = [];
    const releases: Array<() => void> = [];
    const observer = new UniversitySupportObserver(async (currentTurn) => {
      evaluations.push(currentTurn);
      await new Promise<void>((resolve) => releases.push(resolve));
      return {
        key: "same-violation",
        correction: "Correction for the same violation.",
      };
    });
    const injected: InjectMessagePacket[] = [];
    const bus = new PipelineBusImpl();
    bus.on("inject.message", (packet) => {
      injected.push(packet as InjectMessagePacket);
    });
    const drain = bus.start();
    await observer.initialize(bus, {});

    bus.push(Route.Main, {
      kind: "eos.turn_complete",
      contextId: "turn-1",
      timestampMs: Date.now(),
      text: "first",
      transcripts: [],
    });
    await waitFor(() => evaluations.length === 1);
    bus.push(Route.Main, {
      kind: "eos.turn_complete",
      contextId: "turn-2",
      timestampMs: Date.now(),
      text: "second",
      transcripts: [],
    });

    expect(evaluations).toEqual([turn("turn-1", "first")]);
    releases.shift()!();
    await waitFor(() => evaluations.length === 2);
    expect(evaluations).toEqual([turn("turn-1", "first"), turn("turn-2", "second")]);

    releases.shift()!();
    await waitFor(() => injected.length === 1);
    expect(injected).toEqual([
      expect.objectContaining({
        contextId: "turn-1",
        text: "Correction for the same violation.",
        mode: "context",
      }),
    ]);

    await observer.close();
    bus.stop();
    await drain;
  });
});
