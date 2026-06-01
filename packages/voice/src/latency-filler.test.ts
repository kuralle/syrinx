// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
  LatencyFillerController,
  selectLatencyFillerConnective,
  stripRedundantFillerPrefix,
} from "./latency-filler.js";
import { LATENCY_FILLER_FIXTURES } from "./latency-filler-fixtures.js";

describe("selectLatencyFillerConnective", () => {
  it("selects question and gratitude connectives from fixtures", () => {
    for (const fixture of LATENCY_FILLER_FIXTURES) {
      const turnIndex = fixture.id === "statement-1" ? 1 : 0;
      expect(selectLatencyFillerConnective(fixture.userText, turnIndex)).toBe(fixture.expectedConnective);
    }
  });
});

describe("stripRedundantFillerPrefix", () => {
  it("removes a duplicated leading connective without leaving a gap", () => {
    expect(stripRedundantFillerPrefix("So,", "So here's the answer.")).toBe("here's the answer.");
    expect(stripRedundantFillerPrefix("Well,", "  Well, the deadline passed.")).toBe("the deadline passed.");
  });

  it("preserves unrelated LLM text", () => {
    expect(stripRedundantFillerPrefix("So,", "The deadline passed.")).toBe("The deadline passed.");
  });

  it("does not strip filler words embedded in longer words", () => {
    expect(stripRedundantFillerPrefix("So,", "Some people say...")).toBe("Some people say...");
    expect(stripRedundantFillerPrefix("So,", "Social distancing matters")).toBe("Social distancing matters");
    expect(stripRedundantFillerPrefix("Well,", "Wellness is important")).toBe("Wellness is important");
    expect(stripRedundantFillerPrefix("Well,", "Welcome back")).toBe("Welcome back");
    expect(stripRedundantFillerPrefix("Well,", "Wellington is windy")).toBe("Wellington is windy");
  });

  it("still strips a genuine repeated filler connective", () => {
    expect(stripRedundantFillerPrefix("So,", "So, the plan is simple.")).toBe("the plan is simple.");
    expect(stripRedundantFillerPrefix("Well,", "Well, let me explain.")).toBe("let me explain.");
  });
});

describe("LatencyFillerController", () => {
  it("tracks active filler-only state until splice or cancel", () => {
    const controller = new LatencyFillerController({ enabled: true });
    expect(controller.start("turn-1", "hello")).toBe("So,");
    expect(controller.isFillerOnly("turn-1")).toBe(true);
    expect(controller.spliceLlmDelta("turn-1", "The answer is ready.")).toBe("The answer is ready.");
    expect(controller.isFillerOnly("turn-1")).toBe(false);
    expect(controller.getState("turn-1")?.spliced).toBe(true);
  });

  it("marks filler cancelled without splicing", () => {
    const controller = new LatencyFillerController({ enabled: true });
    controller.start("turn-1", "hello");
    const cancelled = controller.cancel("turn-1");
    expect(cancelled?.text).toBe("So,");
    expect(controller.isFillerOnly("turn-1")).toBe(false);
    expect(controller.spliceLlmDelta("turn-1", "ignored")).toBe("ignored");
  });
});
