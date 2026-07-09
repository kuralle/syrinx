// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import type { InteractionObservation, InteractionPolicy } from "../interaction-policy.js";
import { DeferInteractionPolicy } from "./defer.js";

const OBSERVATIONS: InteractionObservation[] = [
  {
    kind: "vad_speech_started",
    contextId: "user",
    timestampMs: 1000,
    confidence: 0.99,
    interruptedContextId: "assistant-turn",
  },
  {
    kind: "vad_speech_activity",
    contextId: "user",
    timestampMs: 1300,
  },
  {
    kind: "vad_speech_ended",
    contextId: "user",
    timestampMs: 2000,
    hasActiveTts: true,
  },
  {
    kind: "vad_barge_in_audio",
    contextId: "user",
    timestampMs: 1500,
    audio: new Uint8Array([1, 2, 3]),
  },
  {
    kind: "stt_partial",
    contextId: "user",
    timestampMs: 1600,
    text: "hello",
    confidence: 0.9,
    interruptedContextId: "assistant-turn",
  },
  {
    kind: "stt_final",
    contextId: "user",
    timestampMs: 2000,
    text: "hello there",
    confidence: 0.95,
    interruptedContextId: "assistant-turn",
  },
  {
    kind: "audio_frame",
    contextId: "user",
    timestampMs: 1700,
    audio: new Int16Array([1, 2, 3]),
  },
  {
    kind: "playout_tick",
    contextId: "assistant-turn",
    timestampMs: 1800,
    playedOutMs: 500,
    ttsActive: true,
  },
  {
    kind: "delegate_state",
    contextId: "turn-1",
    timestampMs: 1900,
    delegateInFlight: true,
  },
];

describe("DeferInteractionPolicy", () => {
  it("implements InteractionPolicy", () => {
    const policy: InteractionPolicy = new DeferInteractionPolicy();
    expect(policy).toBeInstanceOf(DeferInteractionPolicy);
  });

  it("observe returns [] for every observation kind", () => {
    const policy = new DeferInteractionPolicy();
    for (const obs of OBSERVATIONS) {
      expect(policy.observe(obs)).toEqual([]);
    }
  });

  it("reset is a no-op", () => {
    const policy = new DeferInteractionPolicy();
    expect(() => policy.reset("any-context")).not.toThrow();
  });
});