// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PipelineBusImpl,
  Route,
  type EndOfSpeechPacket,
  type InterimEndOfSpeechPacket,
} from "@asyncdot/voice";
import { PipecatEOSPlugin, type SmartTurnPredictor } from "./index.js";

class PredictableSmartTurn implements SmartTurnPredictor {
  constructor(private readonly predictions: number[] = [1]) {}

  async initialize(): Promise<void> {
    // no-op
  }

  async predict(): Promise<number> {
    return this.predictions.shift() ?? 1;
  }

  async close(): Promise<void> {
    // no-op
  }
}

function startBus(bus: PipelineBusImpl): Promise<void> {
  return bus.start();
}

describe("PipecatEOSPlugin", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits interim EOS packets from interim transcripts", async () => {
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new PipecatEOSPlugin(new PredictableSmartTurn());
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
    const plugin = new PipecatEOSPlugin(new PredictableSmartTurn([0.9]));
    const completions: EndOfSpeechPacket[] = [];
    const finalizeRequests: string[] = [];
    bus.on("eos.turn_complete", (pkt) => {
      completions.push(pkt as EndOfSpeechPacket);
    });
    bus.on("stt.finalize", (pkt) => {
      finalizeRequests.push(pkt.contextId);
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
    expect(finalizeRequests).toEqual(["turn-1"]);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("finalizes on max timeout even if VAD stop never arrives", async () => {
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new PipecatEOSPlugin(new PredictableSmartTurn());
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

  it("does not complete a turn for an incomplete smart-turn pause", async () => {
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new PipecatEOSPlugin(new PredictableSmartTurn([0.1, 0.9]));
    const completions: EndOfSpeechPacket[] = [];
    bus.on("eos.turn_complete", (pkt) => {
      completions.push(pkt as EndOfSpeechPacket);
    });

    await plugin.initialize(bus, { finalize_delay_ms: 5, max_delay_ms: 100 });
    bus.push(Route.Main, {
      kind: "stt.result",
      contextId: "turn-3",
      timestampMs: Date.now(),
      text: "I need to know",
      confidence: 0.95,
    });
    bus.push(Route.Main, {
      kind: "vad.speech_ended",
      contextId: "turn-3",
      timestampMs: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(completions).toEqual([]);

    bus.push(Route.Main, {
      kind: "vad.speech_started",
      contextId: "turn-3",
      timestampMs: Date.now(),
      confidence: 0.9,
    });
    bus.push(Route.Main, {
      kind: "stt.result",
      contextId: "turn-3",
      timestampMs: Date.now(),
      text: "whether the petition is approved",
      confidence: 0.95,
    });
    bus.push(Route.Main, {
      kind: "vad.speech_ended",
      contextId: "turn-3",
      timestampMs: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(completions).toEqual([
      expect.objectContaining({
        contextId: "turn-3",
        text: "I need to know whether the petition is approved",
      }),
    ]);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("falls back after sustained silence when smart turn predicts an incomplete pause", async () => {
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new PipecatEOSPlugin(new PredictableSmartTurn([0.1]));
    const completions: EndOfSpeechPacket[] = [];
    bus.on("eos.turn_complete", (pkt) => {
      completions.push(pkt as EndOfSpeechPacket);
    });

    await plugin.initialize(bus, { finalize_delay_ms: 5, max_delay_ms: 100, incomplete_fallback_ms: 10, semantic_shortcut_delay_ms: 5 });
    bus.push(Route.Main, {
      kind: "stt.result",
      contextId: "turn-4",
      timestampMs: Date.now(),
      text: "finished despite low confidence",
      confidence: 0.95,
    });
    bus.push(Route.Main, {
      kind: "vad.speech_ended",
      contextId: "turn-4",
      timestampMs: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(completions).toEqual([
      expect.objectContaining({
        contextId: "turn-4",
        text: "finished despite low confidence",
      }),
    ]);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("requests STT finalization only after smart turn approves the boundary", async () => {
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new PipecatEOSPlugin(new PredictableSmartTurn([0.9]));
    const requests: string[] = [];
    bus.on("stt.finalize", (pkt) => {
      requests.push(pkt.contextId);
    });

    await plugin.initialize(bus, { finalize_delay_ms: 5 });
    bus.push(Route.Main, {
      kind: "vad.speech_ended",
      contextId: "turn-5",
      timestampMs: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(requests).toEqual(["turn-5"]);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("defers semantic mid-thought pauses even when smart turn approves the boundary", async () => {
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new PipecatEOSPlugin(new PredictableSmartTurn([0.9, 0.9]));
    const completions: EndOfSpeechPacket[] = [];
    const finalizeRequests: string[] = [];
    bus.on("eos.turn_complete", (pkt) => {
      completions.push(pkt as EndOfSpeechPacket);
    });
    bus.on("stt.finalize", (pkt) => {
      finalizeRequests.push(pkt.contextId);
    });

    await plugin.initialize(bus, {
      finalize_delay_ms: 5,
      semantic_defer_fallback_ms: 100,
      incomplete_fallback_ms: 100,
    });
    bus.push(Route.Main, {
      kind: "stt.result",
      contextId: "turn-6",
      timestampMs: Date.now(),
      text: "I need to know",
      confidence: 0.95,
    });
    bus.push(Route.Main, {
      kind: "vad.speech_ended",
      contextId: "turn-6",
      timestampMs: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(completions).toEqual([]);
    expect(finalizeRequests).toEqual([]);

    bus.push(Route.Main, {
      kind: "vad.speech_started",
      contextId: "turn-6",
      timestampMs: Date.now(),
      confidence: 0.9,
    });
    bus.push(Route.Main, {
      kind: "stt.result",
      contextId: "turn-6",
      timestampMs: Date.now(),
      text: "whether the petition is approved",
      confidence: 0.95,
    });
    bus.push(Route.Main, {
      kind: "vad.speech_ended",
      contextId: "turn-6",
      timestampMs: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(completions).toEqual([
      expect.objectContaining({
        contextId: "turn-6",
        text: "I need to know whether the petition is approved",
      }),
    ]);
    expect(finalizeRequests).toEqual(["turn-6"]);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("shortcuts complete utterances when smart turn is uncertain", async () => {
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new PipecatEOSPlugin(new PredictableSmartTurn([0.1]));
    const completions: EndOfSpeechPacket[] = [];
    bus.on("eos.turn_complete", (pkt) => {
      completions.push(pkt as EndOfSpeechPacket);
    });

    await plugin.initialize(bus, {
      finalize_delay_ms: 100,
      semantic_shortcut_delay_ms: 5,
      incomplete_fallback_ms: 100,
    });
    bus.push(Route.Main, {
      kind: "stt.result",
      contextId: "turn-7",
      timestampMs: Date.now(),
      text: "What are your office hours?",
      confidence: 0.95,
    });
    bus.push(Route.Main, {
      kind: "vad.speech_ended",
      contextId: "turn-7",
      timestampMs: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(completions).toEqual([
      expect.objectContaining({
        contextId: "turn-7",
        text: "What are your office hours?",
      }),
    ]);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("honors semantic shortcut delay when VAD ends before the STT final", async () => {
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new PipecatEOSPlugin(new PredictableSmartTurn([0.1]));
    const completions: EndOfSpeechPacket[] = [];
    bus.on("eos.turn_complete", (pkt) => {
      completions.push(pkt as EndOfSpeechPacket);
    });

    await plugin.initialize(bus, {
      finalize_delay_ms: 250,
      semantic_shortcut_delay_ms: 50,
      incomplete_fallback_ms: 2000,
      max_delay_ms: 0,
    });

    bus.push(Route.Main, {
      kind: "vad.speech_started",
      contextId: "turn-vad-first",
      timestampMs: Date.now(),
      confidence: 0.9,
    });
    bus.push(Route.Main, {
      kind: "stt.interim",
      contextId: "turn-vad-first",
      timestampMs: Date.now(),
      text: "Thanks that answers everything I needed to know today",
    });
    bus.push(Route.Main, {
      kind: "vad.speech_ended",
      contextId: "turn-vad-first",
      timestampMs: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(completions).toEqual([]);

    bus.push(Route.Main, {
      kind: "stt.result",
      contextId: "turn-vad-first",
      timestampMs: Date.now(),
      text: "Thanks that answers everything I needed to know today",
      confidence: 0.95,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(completions).toHaveLength(1);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("finalizes immediately when semantic defer expires still incomplete", async () => {
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new PipecatEOSPlugin(new PredictableSmartTurn([0.9]));
    const completions: EndOfSpeechPacket[] = [];
    bus.on("eos.turn_complete", (pkt) => {
      completions.push(pkt as EndOfSpeechPacket);
    });

    await plugin.initialize(bus, {
      finalize_delay_ms: 250,
      semantic_defer_fallback_ms: 40,
      incomplete_fallback_ms: 2000,
      max_delay_ms: 0,
    });

    bus.push(Route.Main, {
      kind: "stt.result",
      contextId: "turn-defer",
      timestampMs: Date.now(),
      text: "I need to know",
      confidence: 0.95,
    });
    bus.push(Route.Main, {
      kind: "vad.speech_ended",
      contextId: "turn-defer",
      timestampMs: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(completions).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(completions).toHaveLength(1);

    await plugin.close();
    bus.stop();
    await started;
  });
});
