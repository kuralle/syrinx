// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
  evaluateBrowserJitterSmoke,
  interFrameDelays,
  type BrowserJitterSmokeResult,
} from "../scripts/run-browser-jitter-smoke.js";

function passingBrowser(overrides: Partial<BrowserJitterSmokeResult> = {}): BrowserJitterSmokeResult {
  return {
    ok: true,
    networkProfile: "jittery",
    metricsEvents: 1,
    lastMetrics: {
      turnId: "turn-1",
      e2eMs: 950,
      firstAudioPlayedMs: 5000,
    },
    minPlaybackLeadMs: 15,
    audioPlaybackErrors: 0,
    receivedAssistantAudioFrames: 8,
    ...overrides,
  };
}

describe("browser jitter smoke gate", () => {
  it("accepts jitter-buffered playback with populated metrics under jittery impairment", () => {
    expect(evaluateBrowserJitterSmoke({
      browser: passingBrowser(),
      networkProfile: "jittery",
      proxyMaxUplinkGapMs: 60,
    })).toStrictEqual([]);
  });

  it("rejects missing metrics or playback errors", () => {
    const failures = evaluateBrowserJitterSmoke({
      browser: passingBrowser({ metricsEvents: 0, lastMetrics: undefined }),
      networkProfile: "jittery",
      proxyMaxUplinkGapMs: 60,
    });
    expect(failures).toContain("browser did not receive metrics events");
    expect(failures).toContain("metrics missing turn correlation id");
  });

  it("mirrors telephony jitter and bursty delay profiles", () => {
    expect(interFrameDelays("jittery")).toEqual([35, 5, 45, 10, 30, 15, 20]);
    expect(interFrameDelays("bursty")).toEqual([0, 0, 60, 0, 0, 60, 20]);
  });
});
