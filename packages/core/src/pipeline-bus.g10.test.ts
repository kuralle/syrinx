// SPDX-License-Identifier: MIT
//
// G10 repro — bus head-of-line blocking.
//
// The drain loop awaits each sync handler before dequeuing the next batch
// (pipeline-bus.ts: `await this.dispatch(entry.packet)`), and dispatch awaits
// sync handlers serially. So a long-running sync Main handler (in production: the
// AI-SDK bridge running a multi-second LLM generation on `eos.turn_complete`)
// parks the loop — and a Critical `interrupt.detected` pushed during that window
// is NOT dispatched until the slow handler returns. That delays barge-in (and
// defers the llm.delta -> tts.text streaming the slow handler itself produces).
//
// These tests assert the DESIRED behavior: Critical packets are dispatched
// promptly even while a slow Main handler is in flight. They are RED against the
// current bus and turn GREEN once generation no longer parks the drain loop.

import { describe, it, expect } from "vitest";
import { PipelineBusImpl, Route } from "./pipeline-bus.js";
import { VoiceAgentSession } from "./voice-agent-session.js";
import type { PipelineBus } from "./pipeline-bus.js";
import type { VoicePlugin, PluginConfig } from "./plugin-contract.js";
import type { VoicePacket } from "./packets.js";

function pkt(kind: string, contextId = "t1"): VoicePacket {
  return { kind, contextId, timestampMs: Date.now() } as unknown as VoicePacket;
}

describe("G10 — bus head-of-line blocking", () => {
  it("dispatches a Critical interrupt while a slow Main handler is still running", async () => {
    const bus = new PipelineBusImpl();
    const drain = bus.start();

    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const timeline: Array<{ name: string; atMs: number }> = [];
    const t0 = Date.now();
    const mark = (name: string): void => {
      timeline.push({ name, atMs: Date.now() - t0 });
    };

    // Slow Main handler — stands in for the bridge's long LLM generation. Registered
    // as a concurrent producer so it does not park the drain loop.
    bus.on("eos.turn_complete", async () => {
      mark("slow-start");
      await slowGate;
      mark("slow-end");
    }, { concurrent: true });
    // Critical interrupt handler — stands in for barge-in handling.
    bus.on("interrupt.detected", () => {
      mark("interrupt-dispatched");
    });

    bus.push(Route.Main, pkt("eos.turn_complete"));
    await new Promise((r) => setTimeout(r, 20)); // let the slow handler start
    bus.push(Route.Critical, pkt("interrupt.detected"));
    await new Promise((r) => setTimeout(r, 80)); // window in which a healthy bus dispatches Critical

    const interruptedWhileSlowRunning = timeline.some((e) => e.name === "interrupt-dispatched");

    releaseSlow();
    await new Promise((r) => setTimeout(r, 20));
    bus.stop();
    await drain;

    // The interrupt must have been dispatched BEFORE the slow handler finished.
    const interrupt = timeline.find((e) => e.name === "interrupt-dispatched");
    const slowEnd = timeline.find((e) => e.name === "slow-end");
    expect(interrupt, `timeline: ${JSON.stringify(timeline)}`).toBeDefined();
    expect(slowEnd).toBeDefined();
    expect(interruptedWhileSlowRunning).toBe(true);
    expect(interrupt!.atMs).toBeLessThan(slowEnd!.atMs);
  });
});

// Production simulation: a realistic streaming LLM bridge emits tokens over time on
// `eos.turn_complete`. The session sentence-buffers them into `tts.text`. With the
// bus parked on the bridge's (awaited) handler, the deltas it pushes are not
// dispatched until the handler returns — so the FIRST sentence does not reach TTS
// until generation completes (streaming is defeated). Desired: the first sentence
// reaches TTS WHILE generation is still in flight.
class StreamingBridgePlugin implements VoicePlugin {
  generationEndAtMs = -1;
  constructor(private readonly t0Ms: number) {}
  async initialize(bus: PipelineBus, _config: PluginConfig): Promise<void> {
    bus.on("eos.turn_complete", async (pkt) => {
      const contextId = (pkt as { contextId: string }).contextId;
      // Two complete sentences streamed as tokens, 60 ms apart (~360 ms total).
      const tokens = ["Hello", " there.", " How", " are", " you?", " done."];
      for (const token of tokens) {
        await new Promise((r) => setTimeout(r, 60));
        bus.push(Route.Main, { kind: "llm.delta", contextId, timestampMs: Date.now(), text: token } as unknown as VoicePacket);
      }
      bus.push(Route.Main, { kind: "llm.done", contextId, timestampMs: Date.now(), text: tokens.join("") } as unknown as VoicePacket);
      this.generationEndAtMs = Date.now() - this.t0Ms;
    }, { concurrent: true });
  }
  async close(): Promise<void> {}
}

class RecordingTtsPlugin implements VoicePlugin {
  ttsTextAtMs: number[] = [];
  constructor(private readonly t0Ms: number) {}
  async initialize(bus: PipelineBus, _config: PluginConfig): Promise<void> {
    bus.on("tts.text", () => {
      this.ttsTextAtMs.push(Date.now() - this.t0Ms);
    });
  }
  async close(): Promise<void> {}
}

describe("G10 — production simulation: streaming LLM -> TTS not deferred by the bus", () => {
  it("delivers the first sentence to TTS while generation is still in flight", async () => {
    const t0 = Date.now();
    const bridge = new StreamingBridgePlugin(t0);
    const tts = new RecordingTtsPlugin(t0);
    const session = new VoiceAgentSession({ plugins: { bridge: {}, tts: {} } });
    session.registerPlugin("bridge", bridge);
    session.registerPlugin("tts", tts);
    await session.start();

    session.bus.push(Route.Main, {
      kind: "eos.turn_complete",
      contextId: "turn-1",
      timestampMs: Date.now(),
      text: "what time is it",
      transcripts: [],
    } as unknown as VoicePacket);

    // Wait past full generation + drain.
    await new Promise((r) => setTimeout(r, 700));
    if (session.state !== "closed") await session.close();

    const firstTtsTextAtMs = tts.ttsTextAtMs[0] ?? Number.POSITIVE_INFINITY;
    // The first sentence ("Hello there.") completes ~120 ms into a ~360 ms generation.
    // Bug: it is not delivered until generation ends (>= generationEndAtMs).
    // Desired: delivered while generation is still streaming.
    expect(tts.ttsTextAtMs.length, "expected at least one tts.text").toBeGreaterThan(0);
    expect(
      firstTtsTextAtMs,
      `firstTtsText=${firstTtsTextAtMs}ms generationEnd=${bridge.generationEndAtMs}ms all=${JSON.stringify(tts.ttsTextAtMs)}`,
    ).toBeLessThan(bridge.generationEndAtMs);
  });
});
