// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { evaluateLatencyFillerSmoke } from "../scripts/run-latency-filler-smoke.js";

describe("latency filler smoke evaluator", () => {
  it("passes when filler-on cuts endpoint→first-audio latency", () => {
    const failures = evaluateLatencyFillerSmoke({
      off: {
        latencyFillerEnabled: false,
        speechEndToFirstAudioMs: 1200,
        vadSpeechEndToFirstAudioMs: 900,
        audioBytes: 1000,
      },
      on: {
        latencyFillerEnabled: true,
        speechEndToFirstAudioMs: 450,
        vadSpeechEndToFirstAudioMs: 300,
        audioBytes: 1200,
      },
      qualityGate: { passed: false, failures: [] },
    });
    expect(failures).toEqual([]);
  });

  it("fails when filler-on is not faster", () => {
    const failures = evaluateLatencyFillerSmoke({
      off: {
        latencyFillerEnabled: false,
        speechEndToFirstAudioMs: 500,
        vadSpeechEndToFirstAudioMs: 400,
        audioBytes: 800,
      },
      on: {
        latencyFillerEnabled: true,
        speechEndToFirstAudioMs: 700,
        vadSpeechEndToFirstAudioMs: 600,
        audioBytes: 900,
      },
      qualityGate: { passed: false, failures: [] },
    });
    expect(failures.length).toBeGreaterThan(0);
  });
});
