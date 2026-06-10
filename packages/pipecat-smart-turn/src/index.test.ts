// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PipelineBusImpl,
  Route,
  type EndOfSpeechPacket,
  type InterimEndOfSpeechPacket,
} from "@kuralle-syrinx/core";
import { pcm16SamplesToBytes } from "@kuralle-syrinx/core/audio";
import { PipecatEOSPlugin, type SmartTurnPredictor } from "./index.js";

class PredictableSmartTurn implements SmartTurnPredictor {
  readonly audioInputs: Float32Array[] = [];

  constructor(private readonly predictions: number[] = [1]) {}

  async initialize(): Promise<void> {
    // no-op
  }

  async predict(audio: Float32Array): Promise<number> {
    this.audioInputs.push(audio);
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

  it("does not max-finalize an early provider final while VAD still reports active speech", async () => {
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new PipecatEOSPlugin(new PredictableSmartTurn([0.9]));
    const completions: EndOfSpeechPacket[] = [];
    bus.on("eos.turn_complete", (pkt) => {
      completions.push(pkt as EndOfSpeechPacket);
    });

    await plugin.initialize(bus, { finalize_delay_ms: 5, max_delay_ms: 10 });
    bus.push(Route.Main, {
      kind: "vad.speech_started",
      contextId: "turn-early-final",
      timestampMs: Date.now(),
      confidence: 0.9,
    });
    bus.push(Route.Main, {
      kind: "stt.result",
      contextId: "turn-early-final",
      timestampMs: Date.now(),
      text: "first half",
      confidence: 0.9,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(completions).toEqual([]);

    bus.push(Route.Main, {
      kind: "vad.speech_ended",
      contextId: "turn-early-final",
      timestampMs: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(completions).toEqual([
      expect.objectContaining({
        kind: "eos.turn_complete",
        contextId: "turn-early-final",
        text: "first half",
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
      text: "whether the petition is approved.",
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
        text: "I need to know whether the petition is approved.",
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

  it("accumulates odd-byteOffset VAD PCM without constructing an unaligned Int16Array view", async () => {
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const predictor = new PredictableSmartTurn([0.9]);
    const plugin = new PipecatEOSPlugin(predictor);
    const requests: string[] = [];
    bus.on("stt.finalize", (pkt) => {
      requests.push(pkt.contextId);
    });

    await plugin.initialize(bus, { finalize_delay_ms: 5 });
    const bytes = pcm16SamplesToBytes(new Int16Array([0, 32767, -32768, 16384]));
    const backing = new Uint8Array(bytes.byteLength + 1);
    backing.set(bytes, 1);
    const oddOffsetFrame = backing.subarray(1);
    expect(oddOffsetFrame.byteOffset % 2).toBe(1);

    bus.push(Route.Main, {
      kind: "vad.audio",
      contextId: "turn-odd-offset",
      timestampMs: Date.now(),
      audio: oddOffsetFrame,
    });
    bus.push(Route.Main, {
      kind: "vad.speech_ended",
      contextId: "turn-odd-offset",
      timestampMs: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(requests).toEqual(["turn-odd-offset"]);
    expect(predictor.audioInputs).toHaveLength(1);
    expect(Array.from(predictor.audioInputs[0]!)).toEqual([
      0,
      32767 / 32768,
      -1,
      0.5,
    ]);

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
      text: "Thanks, that answers everything I needed to know today.",
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
      text: "Thanks, that answers everything I needed to know today.",
      confidence: 0.95,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(completions).toHaveLength(1);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("does not shortcut low-confidence semantic partials before fallback", async () => {
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new PipecatEOSPlugin(new PredictableSmartTurn([0.1]));
    const completions: EndOfSpeechPacket[] = [];
    bus.on("eos.turn_complete", (pkt) => {
      completions.push(pkt as EndOfSpeechPacket);
    });

    await plugin.initialize(bus, {
      finalize_delay_ms: 5,
      semantic_shortcut_delay_ms: 5,
      incomplete_fallback_ms: 80,
      max_delay_ms: 0,
    });
    bus.push(Route.Main, {
      kind: "stt.result",
      contextId: "turn-weak-semantic",
      timestampMs: Date.now(),
      text: "I was wondering if I can still add biology",
      confidence: 0.95,
    });
    bus.push(Route.Main, {
      kind: "vad.speech_ended",
      contextId: "turn-weak-semantic",
      timestampMs: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(completions).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(completions).toHaveLength(1);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("suppresses same-context duplicate completions while the assistant is still playing", async () => {
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new PipecatEOSPlugin(new PredictableSmartTurn([0.9, 0.9]));
    const completions: EndOfSpeechPacket[] = [];
    bus.on("eos.turn_complete", (pkt) => {
      completions.push(pkt as EndOfSpeechPacket);
    });

    await plugin.initialize(bus, { finalize_delay_ms: 5, max_delay_ms: 0 });
    bus.push(Route.Main, {
      kind: "vad.speech_started",
      contextId: "review-turn",
      timestampMs: Date.now(),
      confidence: 0.9,
    });
    bus.push(Route.Main, {
      kind: "stt.result",
      contextId: "review-turn",
      timestampMs: Date.now(),
      text: "Hi. I'm Maya Chen, and I can still add biology one oh one.",
      confidence: 0.95,
    });
    bus.push(Route.Main, {
      kind: "vad.speech_ended",
      contextId: "review-turn",
      timestampMs: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(completions).toHaveLength(1);

    bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "review-turn",
      timestampMs: Date.now(),
      audio: new Uint8Array([1, 2, 3, 4]),
      sampleRateHz: 16000,
    });
    bus.push(Route.Main, {
      kind: "vad.speech_started",
      contextId: "review-turn",
      timestampMs: Date.now(),
      confidence: 0.9,
    });
    bus.push(Route.Main, {
      kind: "stt.result",
      contextId: "review-turn",
      timestampMs: Date.now(),
      text: "and what form I should submit.",
      confidence: 0.95,
    });
    bus.push(Route.Main, {
      kind: "vad.speech_ended",
      contextId: "review-turn",
      timestampMs: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(completions).toEqual([
      expect.objectContaining({
        contextId: "review-turn",
        text: "Hi. I'm Maya Chen, and I can still add biology one oh one.",
      }),
    ]);

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

  it("does not force-finalize semantic defer while speech is active again", async () => {
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new PipecatEOSPlugin(new PredictableSmartTurn([0.9]));
    const completions: EndOfSpeechPacket[] = [];
    bus.on("eos.turn_complete", (pkt) => {
      completions.push(pkt as EndOfSpeechPacket);
    });

    await plugin.initialize(bus, {
      finalize_delay_ms: 250,
      semantic_defer_fallback_ms: 30,
      incomplete_fallback_ms: 2000,
      max_delay_ms: 0,
    });

    bus.push(Route.Main, {
      kind: "stt.result",
      contextId: "turn-defer-active",
      timestampMs: Date.now(),
      text: "I need to know",
      confidence: 0.95,
    });
    bus.push(Route.Main, {
      kind: "vad.speech_ended",
      contextId: "turn-defer-active",
      timestampMs: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    bus.push(Route.Main, {
      kind: "vad.speech_started",
      contextId: "turn-defer-active",
      timestampMs: Date.now(),
      confidence: 0.9,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(completions).toEqual([]);

    await plugin.close();
    bus.stop();
    await started;
  });
});

describe("PipecatEOSPlugin — STT-quiet fallback (wedged VAD)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("completes the turn when transcripts go quiet but VAD never ends the segment", async () => {
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new PipecatEOSPlugin(new PredictableSmartTurn([0.9]));
    const turns: EndOfSpeechPacket[] = [];
    bus.on("eos.turn_complete", (pkt) => {
      turns.push(pkt as EndOfSpeechPacket);
    });

    await plugin.initialize(bus, { finalize_delay_ms: 5, stt_quiet_fallback_ms: 40, max_delay_ms: 0 });

    // Speech starts and NEVER ends (saturated VAD on a long telephony segment).
    bus.push(Route.Main, {
      kind: "vad.speech_started",
      contextId: "turn-quiet",
      timestampMs: Date.now(),
      confidence: 0.95,
    });
    // Provider STT delivers the user's whole question, then goes quiet.
    bus.push(Route.Main, {
      kind: "stt.result",
      contextId: "turn-quiet",
      timestampMs: Date.now(),
      text: "what is the application deadline",
      confidence: 0.99,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(turns).toHaveLength(0); // not yet — quiet window still open

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(turns).toEqual([
      expect.objectContaining({
        kind: "eos.turn_complete",
        contextId: "turn-quiet",
        text: "what is the application deadline",
      }),
    ]);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("does not fire the fallback while transcripts keep arriving", async () => {
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new PipecatEOSPlugin(new PredictableSmartTurn([0.9]));
    const turns: EndOfSpeechPacket[] = [];
    bus.on("eos.turn_complete", (pkt) => {
      turns.push(pkt as EndOfSpeechPacket);
    });

    await plugin.initialize(bus, { finalize_delay_ms: 5, stt_quiet_fallback_ms: 60, max_delay_ms: 0 });
    bus.push(Route.Main, {
      kind: "vad.speech_started",
      contextId: "turn-active",
      timestampMs: Date.now(),
      confidence: 0.95,
    });
    bus.push(Route.Main, {
      kind: "stt.result",
      contextId: "turn-active",
      timestampMs: Date.now(),
      text: "first part",
      confidence: 0.99,
    });
    // Keep the transcript active: interims every ~30ms push the quiet deadline back.
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      bus.push(Route.Main, {
        kind: "stt.interim",
        contextId: "turn-active",
        timestampMs: Date.now(),
        text: `still talking ${String(i)}`,
      });
    }
    expect(turns).toHaveLength(0);

    await plugin.close();
    bus.stop();
    await started;
  });
});
