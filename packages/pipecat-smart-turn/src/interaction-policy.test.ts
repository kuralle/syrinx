// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { SmartTurnInteractionPolicy } from "./interaction-policy.js";
import type { SmartTurnPredictor } from "./predictor.js";

class PredictableSmartTurn implements SmartTurnPredictor {
  initialized = false;
  closed = false;

  constructor(private readonly probabilities: number[]) {}

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  async predict(): Promise<number> {
    return this.probabilities.shift() ?? 0;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function speechStarted(contextId = "turn-1") {
  return {
    kind: "vad_speech_started" as const,
    contextId,
    timestampMs: 1000,
    confidence: 0.95,
  };
}

function speechEnded(contextId = "turn-1") {
  return {
    kind: "vad_speech_ended" as const,
    contextId,
    timestampMs: 1500,
    hasActiveTts: false,
  };
}

function audioFrame(contextId = "turn-1") {
  return {
    kind: "audio_frame" as const,
    contextId,
    timestampMs: 1520,
    audio: new Int16Array(320),
  };
}

describe("SmartTurnInteractionPolicy", () => {
  it("selects the Silero-boundary + Smart Turn + semantic fusion path", async () => {
    const predictor = new PredictableSmartTurn([1]);
    const policy = new SmartTurnInteractionPolicy(predictor);
    await policy.initialize();

    policy.observe(speechStarted());
    policy.observe({
      kind: "stt_partial",
      contextId: "turn-1",
      timestampMs: 1400,
      text: "What are your office hours?",
    });
    policy.observe(speechEnded());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(policy.observe(audioFrame())).toEqual([
      { kind: "take_turn", confidence: 1, waitMs: 150 },
    ]);
    await policy.close();
    expect(predictor.initialized).toBe(true);
    expect(predictor.closed).toBe(true);
  });

  it("holds an acoustically-complete mid-thought pause, then releases at the safety fallback", async () => {
    const policy = new SmartTurnInteractionPolicy(new PredictableSmartTurn([1]));
    await policy.initialize({ semantic_defer_fallback_ms: 1 });

    policy.observe(speechStarted("turn-hold"));
    policy.observe({
      kind: "stt_partial",
      contextId: "turn-hold",
      timestampMs: 1400,
      text: "I need to know",
    });
    policy.observe(speechEnded("turn-hold"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(policy.observe(audioFrame("turn-hold"))).toEqual([{ kind: "hold" }]);

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(policy.observe(audioFrame("turn-hold"))).toEqual([
      { kind: "take_turn", confidence: 0, waitMs: 0 },
    ]);
    await policy.close();
  });

  it("uses high-confidence semantics to shortcut an uncertain acoustic result", async () => {
    const policy = new SmartTurnInteractionPolicy(new PredictableSmartTurn([0.1]));
    await policy.initialize();

    policy.observe(speechStarted("turn-shortcut"));
    policy.observe({
      kind: "stt_partial",
      contextId: "turn-shortcut",
      timestampMs: 1400,
      text: "What are your office hours?",
    });
    policy.observe(speechEnded("turn-shortcut"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(policy.observe(audioFrame("turn-shortcut"))).toEqual([
      { kind: "take_turn", confidence: 0.9, waitMs: 335 },
    ]);
    await policy.close();
  });

  it("holds a complete endpoint below the configured voiced-duration minimum", async () => {
    const policy = new SmartTurnInteractionPolicy(new PredictableSmartTurn([1]));
    await policy.initialize({ min_speech_ms: 20 });

    policy.observe(speechStarted("turn-min-speech"));
    policy.observe({
      kind: "audio_frame",
      contextId: "turn-min-speech",
      timestampMs: 1200,
      audio: new Int16Array(160),
      sampleRateHz: 16000,
    });
    policy.observe({
      kind: "stt_partial",
      contextId: "turn-min-speech",
      timestampMs: 1400,
      text: "What are your office hours?",
    });
    policy.observe(speechEnded("turn-min-speech"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(policy.observe(audioFrame("turn-min-speech"))).toEqual([{ kind: "hold" }]);
    await policy.close();
  });

  it("keeps synchronous audio-frame observation p99 within 5ms", async () => {
    const policy = new SmartTurnInteractionPolicy(new PredictableSmartTurn([]));
    await policy.initialize({ max_audio_samples: 16000 });
    policy.observe(speechStarted("turn-bench"));

    const durations: number[] = [];
    for (let index = 0; index < 1000; index += 1) {
      const startedAt = performance.now();
      policy.observe(audioFrame("turn-bench"));
      durations.push(performance.now() - startedAt);
    }
    durations.sort((left, right) => left - right);
    const p99 = durations[Math.floor(durations.length * 0.99) - 1] ?? Infinity;
    expect(p99).toBeLessThanOrEqual(5);
    await policy.close();
  });
});
