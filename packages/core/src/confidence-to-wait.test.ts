// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { confidenceToWaitMs } from "./confidence-to-wait.js";

describe("confidenceToWaitMs", () => {
  it("maps high confidence to 150ms and low confidence to 2000ms", () => {
    expect(confidenceToWaitMs(1)).toBe(150);
    expect(confidenceToWaitMs(0)).toBe(2000);
    expect(confidenceToWaitMs(2)).toBe(150);
    expect(confidenceToWaitMs(-1)).toBe(2000);
  });

  it("is monotonic and supports a bounded custom range", () => {
    const waits = [0, 0.25, 0.5, 0.75, 1].map((confidence) => confidenceToWaitMs(confidence));
    expect(waits).toEqual([...waits].sort((a, b) => b - a));
    expect(confidenceToWaitMs(0.5, { minWaitMs: 100, maxWaitMs: 1100 })).toBe(600);
    expect(() => confidenceToWaitMs(0.5, { minWaitMs: 500, maxWaitMs: 100 })).toThrow(/must be >=/);
  });
});
