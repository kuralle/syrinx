// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { DEFAULT_VAP_THRESHOLDS, decideFromProbs } from "./vap-policy.js";
import { StubVapPredictor, VapInteractionPolicy } from "./index.js";

function audioFrame(contextId = "ctx-1", audio = new Int16Array(320)) {
  return {
    kind: "audio_frame" as const,
    contextId,
    timestampMs: Date.now(),
    audio,
  };
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
  it("returns cached decisions synchronously from observe (test:vap-thresholds)", async () => {
    const predictor = new StubVapPredictor();
    predictor.script([
      { pShift: DEFAULT_VAP_THRESHOLDS.take + 0.2, pBackchannel: 0, pHold: 0 },
    ]);
    const policy = new VapInteractionPolicy({ predictor });
    await policy.initialize();

    const first = policy.observe(audioFrame());
    expect(first).toEqual([{ kind: "keep_listening" }]);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = policy.observe(audioFrame());
    expect(second).toEqual([
      { kind: "take_turn", confidence: DEFAULT_VAP_THRESHOLDS.take + 0.2 },
    ]);
  });

  it("gates interrupt on ttsActive and backchannel on delegateInFlight", async () => {
    const predictor = new StubVapPredictor();
    predictor.script([
      { pShift: DEFAULT_VAP_THRESHOLDS.shift + 0.1, pBackchannel: 0, pHold: 0 },
      { pShift: 0, pBackchannel: DEFAULT_VAP_THRESHOLDS.backchannel + 0.1, pHold: 0 },
    ]);
    const policy = new VapInteractionPolicy({ predictor });
    await policy.initialize();

    policy.observe(audioFrame());
    await new Promise((resolve) => setTimeout(resolve, 0));
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
    policy.observe(audioFrame());
    await new Promise((resolve) => setTimeout(resolve, 0));

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