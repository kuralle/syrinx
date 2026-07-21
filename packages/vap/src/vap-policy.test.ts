// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_VAP_THRESHOLDS,
  RollingFeatureBuffer,
  decideFromProbs,
  semanticTranscriptFusion,
  type VapPredictor,
  type VapPredictorFrame,
  type VapProbs,
} from "./vap-policy.js";
import { StubVapPredictor, VapInteractionPolicy } from "./index.js";

function audioFrame(contextId = "ctx-1", audio = new Int16Array(320)) {
  return {
    kind: "audio_frame" as const,
    contextId,
    timestampMs: Date.now(),
    audio,
    sampleRateHz: 16_000,
  };
}

async function flushInference(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("decideFromProbs", () => {
  it("maps each threshold path to the expected InteractionDecision", () => {
    const thresholds = DEFAULT_VAP_THRESHOLDS;
    expect(
      decideFromProbs(
        { pShift: thresholds.shift + 0.1, pBackchannel: 0, pHold: 0 },
        { ttsActive: true, ttsContextId: "tts-1", delegateInFlight: false },
        thresholds,
      ),
    ).toEqual([{ kind: "interrupt", interruptedContextId: "tts-1" }]);

    expect(
      decideFromProbs(
        { pShift: 0, pBackchannel: thresholds.backchannel + 0.1, pHold: 0 },
        { ttsActive: false, ttsContextId: "", delegateInFlight: true },
        thresholds,
      ),
    ).toEqual([{ kind: "backchannel", cue: "mhmm" }]);

    expect(
      decideFromProbs(
        { pShift: thresholds.take + 0.1, pBackchannel: 0, pHold: 0 },
        { ttsActive: false, ttsContextId: "", delegateInFlight: false },
        thresholds,
      ),
    ).toEqual([{ kind: "take_turn", confidence: thresholds.take + 0.1 }]);

    expect(
      decideFromProbs(
        { pShift: 0, pBackchannel: 0, pHold: thresholds.hold + 0.1 },
        { ttsActive: false, ttsContextId: "", delegateInFlight: false },
        thresholds,
      ),
    ).toEqual([{ kind: "hold" }]);

    expect(
      decideFromProbs(
        { pShift: 0.1, pBackchannel: 0.1, pHold: 0.1 },
        { ttsActive: false, ttsContextId: "", delegateInFlight: false },
        thresholds,
      ),
    ).toEqual([{ kind: "keep_listening" }]);
  });
});

describe("VapInteractionPolicy", () => {
  it("does not emit prosody while VAP is dormant", async () => {
    const policy = new VapInteractionPolicy({ predictor: new StubVapPredictor() });
    const sink = vi.fn();
    policy.setAcousticSignalSink(sink);

    expect(() => policy.observe(audioFrame())).not.toThrow();
    await flushInference();

    expect(sink).not.toHaveBeenCalled();
  });

  it("emits prosody only after initialized predictor output", async () => {
    const predictor = new StubVapPredictor();
    predictor.setFallback({ pShift: 0.4, pBackchannel: 0.2, pHold: 0.1 });
    const policy = new VapInteractionPolicy({ predictor });
    const sink = vi.fn();
    policy.setAcousticSignalSink(sink);
    await policy.initialize();

    policy.observe(audioFrame("prosody-turn"));
    await flushInference();

    expect(sink).toHaveBeenCalledWith({
      contextId: "prosody-turn",
      timestampMs: expect.any(Number),
      signal: "prosody",
      payload: {
        channel: "user",
        pShift: 0.4,
        pBackchannel: 0.2,
        pHold: 0.1,
      },
    });
    await policy.close();
  });

  it("returns cached decisions synchronously from observe (test:vap-thresholds)", async () => {
    const predictor = new StubVapPredictor();
    predictor.script([
      { pShift: DEFAULT_VAP_THRESHOLDS.take + 0.2, pBackchannel: 0, pHold: 0 },
    ]);
    const policy = new VapInteractionPolicy({ predictor });
    await policy.initialize();

    const first = policy.observe(audioFrame());
    expect(first).toEqual([{ kind: "keep_listening" }]);

    await flushInference();
    const second = policy.observe(audioFrame());
    expect(second).toEqual([
      { kind: "take_turn", confidence: DEFAULT_VAP_THRESHOLDS.take + 0.2 },
    ]);
  });

  it("gates interrupt on ttsActive and backchannel on delegateInFlight", async () => {
    const predictor = new StubVapPredictor();
    predictor.setFallback({
      pShift: DEFAULT_VAP_THRESHOLDS.shift + 0.1,
      pBackchannel: 0,
      pHold: 0,
    });
    const policy = new VapInteractionPolicy({ predictor });
    await policy.initialize();

    policy.observe(audioFrame());
    await flushInference();
    expect(policy.observe(audioFrame())).toEqual([
      { kind: "take_turn", confidence: DEFAULT_VAP_THRESHOLDS.shift + 0.1 },
    ]);

    policy.observe({
      kind: "playout_tick",
      contextId: "tts-ctx",
      timestampMs: Date.now(),
      ttsActive: true,
    });
    expect(policy.observe(audioFrame())).toEqual([
      { kind: "interrupt", interruptedContextId: "tts-ctx" },
    ]);

    policy.observe({
      kind: "playout_tick",
      contextId: "tts-ctx",
      timestampMs: Date.now(),
      ttsActive: false,
    });
    predictor.setFallback({
      pShift: 0,
      pBackchannel: DEFAULT_VAP_THRESHOLDS.backchannel + 0.1,
      pHold: 0,
    });
    policy.observe(audioFrame());
    await flushInference();

    policy.observe({
      kind: "delegate_state",
      contextId: "ctx-1",
      timestampMs: Date.now(),
      delegateInFlight: false,
    });
    expect(policy.observe(audioFrame())).toEqual([{ kind: "keep_listening" }]);

    policy.observe({
      kind: "delegate_state",
      contextId: "ctx-1",
      timestampMs: Date.now(),
      delegateInFlight: true,
    });
    expect(policy.observe(audioFrame())).toEqual([{ kind: "backchannel", cue: "mhmm" }]);
  });

  it("serializes stable user and assistant frames and resets predictor state", async () => {
    const pushed: VapPredictorFrame[] = [];
    const resets: string[] = [];
    const predictor: VapPredictor = {
      async initialize() {},
      async push(frame) {
        pushed.push(frame);
        return { pShift: 0, pBackchannel: 0, pHold: 0 };
      },
      reset(contextId) {
        resets.push(contextId);
      },
      async close() {},
    };
    const policy = new VapInteractionPolicy({ predictor });
    await policy.initialize();
    const userAudio = new Int16Array([1, 2]);
    const assistantAudio = new Int16Array([3, 4]);

    policy.observe(audioFrame("duplex", userAudio));
    policy.observe({
      kind: "playout_tick",
      contextId: "duplex",
      timestampMs: 2,
      ttsActive: true,
      audio: assistantAudio,
      sampleRateHz: 24_000,
    });
    userAudio[0] = 99;
    assistantAudio[0] = 99;
    await flushInference();

    expect(pushed.map(({ channel, audio, sampleRateHz }) => ({
      channel,
      audio: [...audio],
      sampleRateHz,
    }))).toEqual([
      { channel: "user", audio: [1, 2], sampleRateHz: 16_000 },
      { channel: "assistant", audio: [3, 4], sampleRateHz: 24_000 },
    ]);

    policy.reset("duplex");
    expect(resets).toEqual(["duplex"]);
  });

  it("does not run queued frames across reset and drains inference before close", async () => {
    let releaseFirst!: () => void;
    const firstPush = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const pushed: number[] = [];
    let closed = false;
    const predictor: VapPredictor = {
      async initialize() {},
      async push(frame) {
        pushed.push(frame.audio[0] ?? 0);
        if (pushed.length === 1) await firstPush;
        return { pShift: 0, pBackchannel: 0, pHold: 0 };
      },
      reset() {},
      async close() {
        closed = true;
      },
    };
    const policy = new VapInteractionPolicy({ predictor });
    await policy.initialize();

    policy.observe(audioFrame("reset", new Int16Array([1])));
    policy.observe(audioFrame("reset", new Int16Array([2])));
    await flushInference();
    policy.reset("reset");
    const closing = policy.close();

    expect(closed).toBe(false);
    releaseFirst();
    await closing;
    expect(pushed).toEqual([1]);
    expect(closed).toBe(true);
  });

  it("can fuse per-context transcript evidence into cached VAP probabilities", async () => {
    const predictor = new StubVapPredictor();
    predictor.setFallback({ pShift: 0.8, pBackchannel: 0, pHold: 0 });
    const policy = new VapInteractionPolicy({ predictor, fuseTranscript: semanticTranscriptFusion });
    await policy.initialize();
    policy.observe(audioFrame("fused"));
    await flushInference();

    policy.observe({
      kind: "stt_partial",
      contextId: "fused",
      timestampMs: 1,
      text: "I need to",
    });
    expect(policy.observe(audioFrame("fused"))).toEqual([{ kind: "keep_listening" }]);

    policy.observe({
      kind: "stt_final",
      contextId: "fused",
      timestampMs: 2,
      text: "That is everything.",
    });
    expect(policy.observe(audioFrame("fused"))).toEqual([
      { kind: "take_turn", confidence: 0.9 },
    ]);

    policy.reset("fused");
    expect(policy.observe(audioFrame("fused"))).toEqual([{ kind: "keep_listening" }]);
  });

  it("observe audio_frame p99 stays <= 5ms on the sync path (test:vap-latency-bench)", async () => {
    const predictor = new StubVapPredictor();
    predictor.setFallback({
      pShift: DEFAULT_VAP_THRESHOLDS.take + 0.2,
      pBackchannel: 0,
      pHold: 0,
    });
    const policy = new VapInteractionPolicy({ predictor });
    await policy.initialize();

    const frame = new Int16Array(320);
    const samples = 1000;
    const durations: number[] = [];
    for (let i = 0; i < samples; i += 1) {
      const start = performance.now();
      policy.observe(audioFrame("bench", frame));
      durations.push(performance.now() - start);
    }

    durations.sort((a, b) => a - b);
    const p99 = durations[Math.floor(samples * 0.99) - 1] ?? durations[durations.length - 1] ?? 0;
    expect(p99).toBeLessThanOrEqual(5);
  });
});

describe("RollingFeatureBuffer", () => {
  it("keeps chronological samples after wrap and returns stable snapshots", () => {
    const buffer = new RollingFeatureBuffer(4);
    buffer.append(new Int16Array([3_276, 6_553, 9_830]));
    const first = buffer.snapshot();
    buffer.append(new Int16Array([13_107, 16_384]));

    expect([...first]).toEqual([
      3_276 / 32_768,
      6_553 / 32_768,
      9_830 / 32_768,
    ]);
    expect([...buffer.snapshot()]).toEqual([
      6_553 / 32_768,
      9_830 / 32_768,
      13_107 / 32_768,
      16_384 / 32_768,
    ]);
  });
});
