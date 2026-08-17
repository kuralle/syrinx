// SPDX-License-Identifier: MIT
//
// The slow-handler guard. MEASURED 2026-08-18 on Workers/DO: a non-concurrent handler
// that awaits defers delivery of INBOUND socket events, so the TTS provider stops
// sending and audio stops being PRODUCED for the whole await. The media lane cannot
// compensate — it routes audio that has already arrived. These tests pin the guard that
// makes that class of handler visible before it ships.

import { describe, expect, it, vi, afterEach } from "vitest";

import { PipelineBusImpl, Route, SLOW_HANDLER_WARN_MS, type VoicePacket } from "./index.js";

function packet(kind: string): VoicePacket {
  return { kind, contextId: "t", timestampMs: 0 } as unknown as VoicePacket;
}

async function withBus(run: (bus: PipelineBusImpl) => Promise<void>): Promise<void> {
  const bus = new PipelineBusImpl();
  void bus.start();
  try {
    await run(bus);
  } finally {
    bus.stop();
  }
}

/** Resolve once the bus has drained the packets pushed so far. */
async function settle(ms = SLOW_HANDLER_WARN_MS * 2 + 60): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("slow non-concurrent handler guard", () => {
  it("warns when a non-concurrent handler holds the drain loop past the threshold", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await withBus(async (bus) => {
      bus.on("stt.result", async () => {
        await new Promise((resolve) => setTimeout(resolve, SLOW_HANDLER_WARN_MS + 40));
      });
      bus.push(Route.Main, packet("stt.result"));
      await settle();
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    // The warning has to name the packet AND the remedy; a bare "slow handler" line
    // sends the reader back to the drain loop to work out what to do.
    expect(message).toContain("stt.result");
    expect(message).toContain("concurrent: true");
  });

  it("stays silent for a handler that returns within the threshold", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await withBus(async (bus) => {
      // Awaiting is legal consumer semantics. Duration is the hazard, not the promise —
      // so a brief await must NOT warn, or the guard becomes noise and gets ignored.
      bus.on("stt.result", async () => {
        await Promise.resolve();
      });
      bus.push(Route.Main, packet("stt.result"));
      await settle();
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("stays silent for a slow handler registered concurrent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await withBus(async (bus) => {
      bus.on(
        "stt.result",
        async () => {
          await new Promise((resolve) => setTimeout(resolve, SLOW_HANDLER_WARN_MS + 40));
        },
        { concurrent: true },
      );
      bus.push(Route.Main, packet("stt.result"));
      await settle();
    });
    // Concurrent handlers are dispatched fire-and-forget, so they never park the loop.
    // This is the documented escape hatch the warning points at; flagging it would
    // contradict the advice.
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns once per kind, not once per packet", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await withBus(async (bus) => {
      bus.on("stt.result", async () => {
        await new Promise((resolve) => setTimeout(resolve, SLOW_HANDLER_WARN_MS + 20));
      });
      bus.push(Route.Main, packet("stt.result"));
      bus.push(Route.Main, packet("stt.result"));
      bus.push(Route.Main, packet("stt.result"));
      await settle(SLOW_HANDLER_WARN_MS * 4 + 200);
    });
    // A per-packet warning on a 50/s audio path would bury the signal it exists to give.
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
