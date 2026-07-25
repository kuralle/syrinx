// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from "vitest";
import { Route, VoiceAgentSession } from "@kuralle-syrinx/core";
import {
  buildBrowserMetricsMessage,
  TurnMetricsTracker,
  type BrowserMetricsMessage,
} from "./turn-metrics.js";
import { waitForCondition } from "./test-helpers.js";

describe("turn metrics", () => {
  it("computes stage latencies from synthetic timestamps", () => {
    const message = buildBrowserMetricsMessage("turn-a", {
      speechEndMs: 1000,
      sttFinalMs: 1200,
      eosMs: 0,
      vadStopHangoverMs: 0,
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
      eouBudgetMs: {
        sttFinalDelayMs: 200,
        totalMs: 200,
      },
    });
  });

  it("buildBrowserMetricsMessage eou budget sums hangover, stt-final, and endpoint delays", () => {
    const message = buildBrowserMetricsMessage("turn-eou-unit", {
      speechEndMs: 1000,
      sttFinalMs: 1250,
      eosMs: 1300,
      vadStopHangoverMs: 80,
      textReadyMs: 0,
      firstAudioByteMs: 0,
      firstAudioPlayedMs: 0,
      lastAudioPlayedMs: 0,
    });

    expect(message.eouBudgetMs).toEqual({
      vadStopHangoverMs: 80,
      sttFinalDelayMs: 250,
      endpointDelayMs: 50,
      totalMs: 380,
    });
    expect(message.sttMs).toBe(250);
  });

  // The edge/DO transport is client-paced: the browser reports its own playout clock
  // and edge.ts forwards it, but nothing emits `tts.playout_started` there. These two
  // pin down that `finalizeOnTtsEnd` is a floor for silent clients only — it must not
  // pre-empt a client that IS reporting, because tts.end (synthesis done) always
  // precedes playout completion (playback done).
  describe("finalizeOnTtsEnd — the edge floor", () => {
    const driveTurnToTtsEnd = (session: VoiceAgentSession, contextId: string): void => {
      session.bus.push(Route.Main, { kind: "vad.speech_ended", contextId, timestampMs: 500 });
      session.bus.push(Route.Main, {
        kind: "stt.result", contextId, timestampMs: 700, text: "hello", confidence: 0.99,
      });
      session.bus.push(Route.Main, { kind: "llm.delta", contextId, timestampMs: 900, text: "hi" });
      session.bus.push(Route.Main, {
        kind: "tts.audio", contextId, timestampMs: 1100, audio: new Uint8Array(640), sampleRateHz: 16000,
      });
    };

    it("does not pre-empt a client that reports playout, keeping the played marks", async () => {
      const session = new VoiceAgentSession({ plugins: {} });
      const emitted: BrowserMetricsMessage[] = [];
      const tracker = new TurnMetricsTracker(
        session.bus, (m) => emitted.push(m), undefined, { finalizeOnTtsEnd: true },
      );
      tracker.wire([]);
      void session.start();

      driveTurnToTtsEnd(session, "reporting");
      // Browser starts playing and says so — no playout_started on this transport.
      session.bus.push(Route.Main, {
        kind: "tts.playout_progress", contextId: "reporting", timestampMs: 1200,
        playedOutMs: 40, complete: false,
      });
      // Synthesis finishes BEFORE playback does. The floor must stay its hand here.
      session.bus.push(Route.Main, { kind: "tts.end", contextId: "reporting", timestampMs: 1300 });
      await new Promise((r) => setTimeout(r, 50));
      expect(emitted, "tts.end must not finalize a reporting client").toHaveLength(0);

      // Playback actually finishes.
      session.bus.push(Route.Main, {
        kind: "tts.playout_progress", contextId: "reporting", timestampMs: 4000,
        playedOutMs: 2800, complete: true,
      });
      await waitForCondition(() => emitted.length === 1);
      const message = emitted[0];
      // The whole point: these survive, and e2e is measured to audio PLAYED, not to
      // first byte — the same semantics the Node path reports.
      expect(message?.firstAudioPlayedMs).toBe(1200);
      expect(message?.lastAudioPlayedMs).toBe(4000);
      expect(message?.e2eMs).toBe(700);
    });

    it("floors on tts.end for a client that never reports playout", async () => {
      const session = new VoiceAgentSession({ plugins: {} });
      const emitted: BrowserMetricsMessage[] = [];
      const tracker = new TurnMetricsTracker(
        session.bus, (m) => emitted.push(m), undefined, { finalizeOnTtsEnd: true },
      );
      tracker.wire([]);
      void session.start();

      driveTurnToTtsEnd(session, "silent");
      session.bus.push(Route.Main, { kind: "tts.end", contextId: "silent", timestampMs: 1300 });
      await waitForCondition(() => emitted.length === 1);

      const message = emitted[0];
      expect(message?.ttsTTFBMs).toBe(200);
      // Never measured, so omitted rather than zeroed.
      expect(message?.firstAudioPlayedMs).toBeUndefined();
      expect(message?.lastAudioPlayedMs).toBeUndefined();
    });

    it("leaves the Node path alone — no floor unless opted in", async () => {
      const session = new VoiceAgentSession({ plugins: {} });
      const emitted: BrowserMetricsMessage[] = [];
      const tracker = new TurnMetricsTracker(session.bus, (m) => emitted.push(m));
      tracker.wire([]);
      void session.start();

      driveTurnToTtsEnd(session, "node");
      session.bus.push(Route.Main, { kind: "tts.end", contextId: "node", timestampMs: 1300 });
      await new Promise((r) => setTimeout(r, 50));
      expect(emitted, "default must not finalize on tts.end").toHaveLength(0);
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

  it("eou_budget_breakdown: vad hangover, stt-final delay, endpoint delay, and total", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const emitted: unknown[] = [];
    const tracker = new TurnMetricsTracker(session.bus, (message) => emitted.push(message));
    const disposers: Array<() => void> = [];
    tracker.wire(disposers);
    void session.start();

    session.bus.push(Route.Main, {
      kind: "vad.speech_ended",
      contextId: "turn-eou",
      timestampMs: 1000,
    });
    session.bus.push(Route.Main, {
      kind: "metric.conversation",
      contextId: "turn-eou",
      timestampMs: 1005,
      name: "vad.stop_hangover_ms",
      value: "80",
    });
    session.bus.push(Route.Main, {
      kind: "stt.result",
      contextId: "turn-eou",
      timestampMs: 1250,
      text: "hello",
      confidence: 0.99,
    });
    session.bus.push(Route.Main, {
      kind: "eos.turn_complete",
      contextId: "turn-eou",
      timestampMs: 1300,
      text: "hello",
      transcripts: [],
    });
    session.bus.push(Route.Main, {
      kind: "tts.playout_progress",
      contextId: "turn-eou",
      timestampMs: 1500,
      playedOutMs: 100,
      complete: true,
    });

    await waitForCondition(() => emitted.length === 1);
    expect(emitted[0]).toMatchObject({
      type: "metrics",
      turnId: "turn-eou",
      correlationId: "turn-eou",
      sttMs: 250,
      eouBudgetMs: {
        vadStopHangoverMs: 80,
        sttFinalDelayMs: 250,
        endpointDelayMs: 50,
        totalMs: 380,
      },
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

describe("turn metrics — endpointing decision", () => {
  const emptyMarks = {
    speechEndMs: 0,
    sttFinalMs: 0,
    eosMs: 0,
    vadStopHangoverMs: 0,
    textReadyMs: 0,
    firstAudioByteMs: 0,
    firstAudioPlayedMs: 0,
    lastAudioPlayedMs: 0,
  };

  it("emits the owner/reason when the turn state carries them", () => {
    const message = buildBrowserMetricsMessage("turn-dec", {
      ...emptyMarks,
      endpointingOwner: "smart_turn",
      endpointingReason: "end_of_speech",
    });
    expect(message.endpointingOwner).toBe("smart_turn");
    expect(message.endpointingReason).toBe("end_of_speech");
  });

  it("overrides the reason to force_finalized when the watchdog fired, even if the emitter said end_of_speech", () => {
    // The completing eos may come from the STT plugin, which cannot know the
    // force-finalize watchdog fired underneath it. The tracker reads that mark
    // independently, so the truth wins here regardless of emitter.
    const message = buildBrowserMetricsMessage("turn-forced", {
      ...emptyMarks,
      endpointingOwner: "provider_stt",
      endpointingReason: "end_of_speech",
      forceFinalized: true,
    });
    expect(message.endpointingOwner).toBe("provider_stt");
    expect(message.endpointingReason).toBe("force_finalized");
  });

  it("omits the decision when the state has none (absent means absent)", () => {
    const message = buildBrowserMetricsMessage("turn-none", { ...emptyMarks });
    expect(message.endpointingOwner).toBeUndefined();
    expect(message.endpointingReason).toBeUndefined();
  });

  it("captures owner from the completing eos and force-finalize from the watchdog metric", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const emitted: BrowserMetricsMessage[] = [];
    const tracker = new TurnMetricsTracker(session.bus, (m) => emitted.push(m));
    const disposers: Array<() => void> = [];
    tracker.wire(disposers);
    void session.start();

    // The completing eos carries owner=provider_stt, reason=end_of_speech ...
    session.bus.push(Route.Main, {
      kind: "eos.turn_complete",
      contextId: "turn-dec",
      timestampMs: 1000,
      text: "hi",
      transcripts: [],
      endpointingOwner: "provider_stt",
      endpointingReason: "end_of_speech",
    });
    // ... but the force-finalize watchdog fired for this turn — its mark arrives
    // on the bus independently and must override the emitter's reason.
    session.bus.push(Route.Background, {
      kind: "metric.conversation",
      contextId: "turn-dec",
      timestampMs: 1050,
      name: "stt.force_finalized",
      value: "1",
    });
    // The watchdog mark rides the lower-priority Background route, which the bus
    // drains only after Main. Let it land before playout completes (as it does in
    // production, where the watchdog fires during STT, long before playback ends).
    await new Promise((resolve) => setTimeout(resolve, 10));
    session.bus.push(Route.Main, {
      kind: "tts.playout_progress",
      contextId: "turn-dec",
      timestampMs: 2000,
      playedOutMs: 0,
      complete: true,
    });

    await waitForCondition(() => emitted.length === 1);
    expect(emitted[0]!.endpointingOwner).toBe("provider_stt");
    expect(emitted[0]!.endpointingReason).toBe("force_finalized");

    for (const dispose of disposers) dispose();
    await session.close();
  });
});
