// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from "vitest";
import { Route, VoiceAgentSession } from "@asyncdot/voice";
import {
  buildBrowserMetricsMessage,
  TurnMetricsTracker,
} from "./turn-metrics.js";
import { waitForCondition } from "./test-helpers.js";

describe("turn metrics", () => {
  it("computes stage latencies from synthetic timestamps", () => {
    const message = buildBrowserMetricsMessage("turn-a", {
      speechEndMs: 1000,
      sttFinalMs: 1200,
      textReadyMs: 1500,
      firstAudioByteMs: 1700,
      firstAudioPlayedMs: 1900,
      lastAudioPlayedMs: 2500,
    });

    expect(message).toEqual({
      type: "metrics",
      turnId: "turn-a",
      correlationId: "turn-a",
      speechEndMs: 1000,
      textReadyMs: 1500,
      firstAudioByteMs: 1700,
      firstAudioPlayedMs: 1900,
      lastAudioPlayedMs: 2500,
      sttMs: 200,
      llmTTFTMs: 300,
      ttsTTFBMs: 200,
      e2eMs: 900,
    });
  });

  it("keeps correlation id stable for the turn context", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const emitted: unknown[] = [];
    const tracker = new TurnMetricsTracker(session.bus, (message) => emitted.push(message));
    const disposers: Array<() => void> = [];
    tracker.wire(disposers);
    void session.start();

    session.bus.push(Route.Main, {
      kind: "vad.speech_ended",
      contextId: "turn-correlation",
      timestampMs: 500,
    });
    session.bus.push(Route.Main, {
      kind: "stt.result",
      contextId: "turn-correlation",
      timestampMs: 700,
      text: "hello",
      confidence: 0.99,
    });
    session.bus.push(Route.Main, {
      kind: "llm.delta",
      contextId: "turn-correlation",
      timestampMs: 900,
      text: "hi",
    });
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "turn-correlation",
      timestampMs: 1100,
      audio: new Uint8Array(640),
      sampleRateHz: 16000,
    });
    session.bus.push(Route.Main, {
      kind: "tts.playout_started",
      contextId: "turn-correlation",
      timestampMs: 1100,
    });
    session.bus.push(Route.Main, {
      kind: "tts.playout_progress",
      contextId: "turn-correlation",
      timestampMs: 1300,
      playedOutMs: 200,
      complete: false,
    });
    session.bus.push(Route.Main, {
      kind: "tts.playout_progress",
      contextId: "turn-correlation",
      timestampMs: 1800,
      playedOutMs: 120,
      complete: true,
    });

    await waitForCondition(() => emitted.length === 1);
    expect(emitted[0]).toMatchObject({
      type: "metrics",
      turnId: "turn-correlation",
      correlationId: "turn-correlation",
      sttMs: 200,
      llmTTFTMs: 200,
      ttsTTFBMs: 200,
      e2eMs: 600,
    });

    for (const dispose of disposers) dispose();
    await session.close();
  });

  it("records firstAudioPlayedMs from playout_started, not throttled progress", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const emitted: unknown[] = [];
    const tracker = new TurnMetricsTracker(session.bus, (message) => emitted.push(message));
    const disposers: Array<() => void> = [];
    tracker.wire(disposers);
    void session.start();

    session.bus.push(Route.Main, {
      kind: "vad.speech_ended",
      contextId: "turn-throttle",
      timestampMs: 1000,
    });
    session.bus.push(Route.Main, {
      kind: "tts.playout_started",
      contextId: "turn-throttle",
      timestampMs: 1100,
    });
    session.bus.push(Route.Main, {
      kind: "tts.playout_progress",
      contextId: "turn-throttle",
      timestampMs: 1300,
      playedOutMs: 200,
      complete: true,
    });

    await waitForCondition(() => emitted.length === 1);
    expect(emitted[0]).toMatchObject({
      firstAudioPlayedMs: 1100,
      e2eMs: 100,
    });

    for (const dispose of disposers) dispose();
    await session.close();
  });

  it("emits metrics once when playout completes for a wired browser session", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const emitted: unknown[] = [];
    const tracker = new TurnMetricsTracker(session.bus, (message) => emitted.push(message));
    const disposers: Array<() => void> = [];
    tracker.wire(disposers);
    void session.start();

    session.bus.push(Route.Main, {
      kind: "vad.speech_ended",
      contextId: "turn-live",
      timestampMs: 10_000,
    });
    session.bus.push(Route.Main, {
      kind: "stt.result",
      contextId: "turn-live",
      timestampMs: 10_200,
      text: "hello",
      confidence: 0.99,
    });
    session.bus.push(Route.Main, {
      kind: "llm.delta",
      contextId: "turn-live",
      timestampMs: 10_450,
      text: "hi",
    });
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "turn-live",
      timestampMs: 10_600,
      audio: new Uint8Array(640),
      sampleRateHz: 16000,
    });
    session.bus.push(Route.Main, {
      kind: "tts.playout_started",
      contextId: "turn-live",
      timestampMs: 10_600,
    });
    session.bus.push(Route.Main, {
      kind: "tts.playout_progress",
      contextId: "turn-live",
      timestampMs: 10_800,
      playedOutMs: 200,
      complete: false,
    });
    session.bus.push(Route.Main, {
      kind: "tts.playout_progress",
      contextId: "turn-live",
      timestampMs: 11_000,
      playedOutMs: 120,
      complete: true,
    });

    await waitForCondition(() => emitted.length === 1);
    expect(emitted[0]).toMatchObject({
      type: "metrics",
      turnId: "turn-live",
      correlationId: "turn-live",
      sttMs: 200,
      llmTTFTMs: 250,
      ttsTTFBMs: 150,
      e2eMs: 600,
    });

    for (const dispose of disposers) dispose();
    await session.close();
  });

  it("drops partial turn state on interrupt without emitting metrics", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const emit = vi.fn();
    const tracker = new TurnMetricsTracker(session.bus, emit);
    tracker.wire([]);
    void session.start();

    session.bus.push(Route.Main, {
      kind: "vad.speech_ended",
      contextId: "turn-interrupted",
      timestampMs: 1000,
    });
    session.bus.push(Route.Critical, {
      kind: "interrupt.tts",
      contextId: "turn-interrupted",
      timestampMs: 1100,
    });
    session.bus.push(Route.Main, {
      kind: "tts.playout_progress",
      contextId: "turn-interrupted",
      timestampMs: 1200,
      playedOutMs: 20,
      complete: true,
    });

    await waitForCondition(() => emit.mock.calls.length === 0, 200);
    expect(emit).not.toHaveBeenCalled();

    await session.close();
  });
});
