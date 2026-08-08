// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
  HEARD_PREFIX_CHARS_PER_SECOND,
  computeHeardAssistantPrefix,
  truncateAtWordBoundary,
} from "./heard-assistant-prefix.js";

const FULL = "Alpha beta gamma delta epsilon zeta eta theta.";

describe("computeHeardAssistantPrefix", () => {
  it("uses exact word timings when available", () => {
    const result = computeHeardAssistantPrefix({
      emittedText: FULL,
      playedOutMs: 400,
      wordTimestamps: [
        { word: "Alpha", startMs: 0, endMs: 200 },
        { word: "beta", startMs: 220, endMs: 400 },
        { word: "gamma", startMs: 420, endMs: 600 },
      ],
    });
    expect(result.heard).toBe("Alpha beta");
    expect(result.usedEstimate).toBe(false);
  });

  it("estimates a shorter prefix without word timings", () => {
    const result = computeHeardAssistantPrefix({
      emittedText: FULL,
      playedOutMs: 400,
      wordTimestamps: undefined,
    });
    expect(result.heard.length).toBeGreaterThan(0);
    expect(result.heard.length).toBeLessThan(FULL.length);
    expect(result.heard).not.toBe(FULL);
    expect(result.heard.endsWith(" ")).toBe(false);
    expect(result.usedEstimate).toBe(true);
  });

  it("returns empty prefix for 0 ms playout without timings", () => {
    const result = computeHeardAssistantPrefix({
      emittedText: FULL,
      playedOutMs: 0,
      wordTimestamps: undefined,
    });
    expect(result.heard).toBe("");
    expect(result.usedEstimate).toBe(true);
  });

  it("clamps to full text when playout exceeds the estimated length", () => {
    const longPlayoutMs = Math.ceil((FULL.length / HEARD_PREFIX_CHARS_PER_SECOND) * 1000) + 5000;
    const result = computeHeardAssistantPrefix({
      emittedText: FULL,
      playedOutMs: longPlayoutMs,
      wordTimestamps: undefined,
    });
    expect(result.heard).toBe(FULL);
    expect(result.usedEstimate).toBe(true);
  });
});

describe("truncateAtWordBoundary", () => {
  it("never leaves a partial trailing word", () => {
    expect(truncateAtWordBoundary("Alpha beta gamma", 8)).toBe("Alpha");
    expect(truncateAtWordBoundary("Alpha beta gamma", 3)).toBe("");
  });
});
