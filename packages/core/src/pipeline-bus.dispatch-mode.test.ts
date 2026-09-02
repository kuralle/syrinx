// SPDX-License-Identifier: MIT
//
// Compile-time guard for the dispatch-mode contract: `PipelineBus.on` must refuse an
// `async` handler with no declared mode — that shape is exactly the one that stalls
// audio on Workers/DO (see pipeline-bus.ts's `on` JSDoc). `pnpm -r typecheck` IS this
// guard: a `@ts-expect-error` with no error underneath it fails typecheck, which is
// the sabotage signal for this file. No `vitest --typecheck` needed — core has no
// vitest typecheck config, and adding one would be a gate edit, not a fix.

import { describe, it, expect } from "vitest";
import { PipelineBusImpl, Route, type VoicePacket } from "./index.js";

function packet(kind: string): VoicePacket {
  return { kind, contextId: "t", timestampMs: 0 } as unknown as VoicePacket;
}

describe("PipelineBus.on dispatch-mode contract (type-level)", () => {
  it("accepts a sync handler with no mode", () => {
    const bus = new PipelineBusImpl();
    const dispose = bus.on("stt.result", () => {});
    expect(typeof dispose).toBe("function");
  });

  it("accepts an async handler with { concurrent: true }", () => {
    const bus = new PipelineBusImpl();
    const dispose = bus.on("stt.result", async () => {}, { concurrent: true });
    expect(typeof dispose).toBe("function");
  });

  it("accepts an async handler with { serial: true }", () => {
    const bus = new PipelineBusImpl();
    const dispose = bus.on("stt.result", async () => {}, { serial: true });
    expect(typeof dispose).toBe("function");
  });

  it("rejects an async handler with no mode — compile error, not a runtime throw", () => {
    const bus = new PipelineBusImpl();
    // @ts-expect-error — an async handler must declare { concurrent: true } or { serial: true }.
    bus.on("stt.result", async () => {});
    bus.push(Route.Main, packet("stt.result"));
  });

  it("rejects a plain (non-async) promise-returning handler with no mode — the shape only the compiler can see", () => {
    const bus = new PipelineBusImpl();
    // @ts-expect-error — returning a Promise without the async keyword still requires a mode.
    bus.on("stt.result", () => Promise.resolve());
    bus.push(Route.Main, packet("stt.result"));
  });

  it("rejects { concurrent: true, serial: true } — the two modes are mutually exclusive", () => {
    const bus = new PipelineBusImpl();
    // @ts-expect-error — concurrent and serial cannot both be declared.
    bus.on("stt.result", async () => {}, { concurrent: true, serial: true });
    bus.push(Route.Main, packet("stt.result"));
  });
});
