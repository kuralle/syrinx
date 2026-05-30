// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { evaluate, type BrowserSmokeResult } from "../scripts/run-browser-runtime-capture-smoke.js";

function passingBrowserResult(overrides: Partial<BrowserSmokeResult> = {}): BrowserSmokeResult {
  return {
    ok: true,
    targetSampleRateHz: 16000,
    audioContextSampleRateHz: 48000,
    sentFrames: 3,
    sentEnvelopeFrames: 3,
    sentBytes: 960,
    startedTurns: 1,
    contextIds: ["turn-1"],
    receivedAssistantAudioFrames: 1,
    receivedAssistantEnvelopeFrames: 1,
    receivedAssistantBytes: 16000,
    assistantSampleRateHz: 16000,
    audioClearEvents: 1,
    audioPlaybackErrors: 0,
    ...overrides,
  };
}

function receivedPackets(count: number, bytesPerPacket: number) {
  return Array.from({ length: count }, () => ({
    kind: "user.audio_received" as const,
    contextId: "turn-1",
    timestampMs: 0,
    audio: new Uint8Array(bytesPerPacket),
  }));
}

describe("browser runtime evidence gate", () => {
  it("accepts matching browser-sent and server-received audio evidence", () => {
    expect(evaluate(passingBrowserResult(), receivedPackets(3, 320), "")).toStrictEqual([]);
  });

  it("rejects dropped browser audio frames at the server boundary", () => {
    const failures = evaluate(passingBrowserResult(), receivedPackets(2, 320), "");

    expect(failures).toContain("server received 2 audio packets, browser sent 3");
    expect(failures).toContain("server received 640 PCM bytes, browser sent 960");
  });

  it("rejects server byte accounting drift even when frame counts match", () => {
    const failures = evaluate(passingBrowserResult(), receivedPackets(3, 300), "");

    expect(failures).toContain("server received 900 PCM bytes, browser sent 960");
  });
});
