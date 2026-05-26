// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
  PipelineBusImpl,
  Route,
  type EndOfSpeechPacket,
  type InterimEndOfSpeechPacket,
} from "@asyncdot/voice";
import { PipecatEOSPlugin } from "./index.js";

function startBus(bus: PipelineBusImpl): Promise<void> {
  return bus.start();
}

describe("PipecatEOSPlugin", () => {
  it("emits interim EOS packets from interim transcripts", async () => {
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new PipecatEOSPlugin();
    const interims: InterimEndOfSpeechPacket[] = [];
    bus.on("eos.interim", (pkt) => {
      interims.push(pkt as InterimEndOfSpeechPacket);
    });

    await plugin.initialize(bus, {});
    bus.push(Route.Main, {
      kind: "stt.interim",
      contextId: "turn-1",
      timestampMs: Date.now(),
      text: "hello",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(interims).toEqual([
      expect.objectContaining({
        kind: "eos.interim",
        contextId: "turn-1",
        text: "hello",
      }),
    ]);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("finalizes after VAD stop and final STT result", async () => {
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new PipecatEOSPlugin();
    const completions: EndOfSpeechPacket[] = [];
    bus.on("eos.turn_complete", (pkt) => {
      completions.push(pkt as EndOfSpeechPacket);
    });

    await plugin.initialize(bus, { finalize_delay_ms: 5, max_delay_ms: 50 });
    bus.push(Route.Main, {
      kind: "vad.speech_started",
      contextId: "turn-1",
      timestampMs: Date.now(),
      confidence: 0.9,
    });
    bus.push(Route.Main, {
      kind: "stt.result",
      contextId: "turn-1",
      timestampMs: Date.now(),
      text: "hello world",
      confidence: 0.95,
      language: "en-US",
    });
    bus.push(Route.Main, {
      kind: "vad.speech_ended",
      contextId: "turn-1",
      timestampMs: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(completions).toEqual([
      expect.objectContaining({
        kind: "eos.turn_complete",
        contextId: "turn-1",
        text: "hello world",
        transcripts: [
          expect.objectContaining({
            kind: "stt.result",
            text: "hello world",
          }),
        ],
      }),
    ]);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("finalizes on max timeout even if VAD stop never arrives", async () => {
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new PipecatEOSPlugin();
    const completions: EndOfSpeechPacket[] = [];
    bus.on("eos.turn_complete", (pkt) => {
      completions.push(pkt as EndOfSpeechPacket);
    });

    await plugin.initialize(bus, { finalize_delay_ms: 5, max_delay_ms: 10 });
    bus.push(Route.Main, {
      kind: "stt.result",
      contextId: "turn-2",
      timestampMs: Date.now(),
      text: "timeout final",
      confidence: 0.8,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(completions).toEqual([
      expect.objectContaining({
        kind: "eos.turn_complete",
        contextId: "turn-2",
        text: "timeout final",
      }),
    ]);

    await plugin.close();
    bus.stop();
    await started;
  });
});
