// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from "vitest";
import { Route, VoiceAgentSession, type ConversationMetricPacket } from "@kuralle-syrinx/core";
import {
  buildBrowserMetricsMessage,
  TurnMetricsTracker,
  type BrowserMetricsMessage,
  type TurnLatencyEvent,
  type TurnTimestampState,
} from "./turn-metrics.js";
import { waitForCondition } from "./test-helpers.js";

function emptyMarks(): Omit<TurnTimestampState, "turnLatency"> {
  return {
    speechEndMs: 0,
    sttFinalMs: 0,
    eosMs: 0,
    vadStopHangoverMs: 0,
    textReadyMs: 0,
    firstAudioByteMs: 0,
    firstAudioPlayedMs: 0,
    lastAudioPlayedMs: 0,
  };
}

function fullTurnLatency(overrides: Partial<TurnLatencyEvent> = {}): TurnLatencyEvent {
  return {
    tsMs: 1900,
    turnId: "turn-a",
    ttfaMs: 900,
    anchor: "speech_end",
    unattributedMs: 0,
    eouDelayMs: undefined,
    llmTtftMs: 300,
    textAggregationMs: undefined,
    ttsTtfbMs: 200,
    queuedMs: undefined,
    llmCallCount: undefined,
    fillerUsed: false,
    backchannelUsed: false,
    ...overrides,
  };
}

describe("buildBrowserMetricsMessage", () => {
  it("returns undefined when the session never measured a voice TTFA for this turn", () => {
    const message = buildBrowserMetricsMessage("turn-none", { ...emptyMarks() });
    expect(message).toBeUndefined();
  });

  it("copies the session's turn_latency verbatim and layers transport-only marks on top", () => {
    const message = buildBrowserMetricsMessage("turn-a", {
      ...emptyMarks(),
      speechEndMs: 1000,
      textReadyMs: 1500,
      firstAudioByteMs: 1700,
      firstAudioPlayedMs: 1900,
      lastAudioPlayedMs: 2500,
      turnLatency: fullTurnLatency(),
    });

    expect(message).toEqual({
      type: "metrics",
      turnId: "turn-a",
      correlationId: "turn-a",
      ttfaMs: 900,
      anchor: "speech_end",
      unattributedMs: 0,
      llmTtftMs: 300,
      ttsTtfbMs: 200,
      fillerUsed: false,
      backchannelUsed: false,
      speechEndMs: 1000,
      textReadyMs: 1500,
      firstAudioByteMs: 1700,
      firstAudioPlayedMs: 1900,
      lastAudioPlayedMs: 2500,
      ttfaPlayedMs: 900,
    });
  });

  it("omits optional turn_latency fields the session didn't report, instead of filling zeros", () => {
    const message = buildBrowserMetricsMessage("turn-sparse", {
      ...emptyMarks(),
      turnLatency: fullTurnLatency({ llmTtftMs: undefined, ttsTtfbMs: undefined, queuedMs: undefined }),
    });
    expect(message).not.toHaveProperty("llmTtftMs");
    expect(message).not.toHaveProperty("ttsTtfbMs");
    expect(message).not.toHaveProperty("queuedMs");
    expect(message).not.toHaveProperty("speechEndMs");
    expect(message).not.toHaveProperty("ttfaPlayedMs");
  });

  it("derives the message from the stored turn_latency, not by recomputing from marks (rule 6 sabotage)", () => {
    // speechEndMs -> firstAudioByteMs implies a raw delta of 2000ms, but the session
    // reported ttfaMs 1500 (e.g. a filler spoke first, or queuedMs skew). A regression
    // that recomputes ttfaMs locally from these same marks instead of copying the
    // session's value would report 2000 here — verified by sabotaging turn-metrics.ts
    // to do exactly that and watching this test fail before restoring it.
    const message = buildBrowserMetricsMessage("turn-derived", {
      ...emptyMarks(),
      speechEndMs: 1000,
      firstAudioByteMs: 3000,
      firstAudioPlayedMs: 3000,
      turnLatency: fullTurnLatency({ ttfaMs: 1500, unattributedMs: 1500, llmTtftMs: undefined, ttsTtfbMs: undefined }),
    });
    expect(message?.ttfaMs).toBe(1500);
    expect(message?.ttfaMs).not.toBe(2000);
  });

  describe("eouBudgetMs — still computed from transport marks (turn_latency has no sub-breakdown)", () => {
    it("sums hangover, stt-final, and endpoint delays", () => {
      const message = buildBrowserMetricsMessage("turn-eou-unit", {
        ...emptyMarks(),
        speechEndMs: 1000,
        sttFinalMs: 1250,
        eosMs: 1300,
        vadStopHangoverMs: 80,
        turnLatency: fullTurnLatency({ llmTtftMs: undefined, ttsTtfbMs: undefined }),
      });

      expect(message?.eouBudgetMs).toEqual({
        vadStopHangoverMs: 80,
        sttFinalDelayMs: 250,
        endpointDelayMs: 50,
        totalMs: 380,
      });
    });

    it("is omitted when no budget component was measured", () => {
      const message = buildBrowserMetricsMessage("turn-no-eou", {
        ...emptyMarks(),
        turnLatency: fullTurnLatency({ llmTtftMs: undefined, ttsTtfbMs: undefined }),
      });
      expect(message).not.toHaveProperty("eouBudgetMs");
    });
  });

  describe("ttfaPlayedMs — anchor to first audio PLAYED", () => {
    it("anchors on speechEndMs when anchor is speech_end", () => {
      const message = buildBrowserMetricsMessage("turn-anchor-speech", {
        ...emptyMarks(),
        speechEndMs: 1000,
        firstAudioPlayedMs: 1800,
        turnLatency: fullTurnLatency({ anchor: "speech_end", llmTtftMs: undefined, ttsTtfbMs: undefined }),
      });
      expect(message?.ttfaPlayedMs).toBe(800);
    });

    it("anchors on eosMs when anchor is eos", () => {
      const message = buildBrowserMetricsMessage("turn-anchor-eos", {
        ...emptyMarks(),
        eosMs: 1200,
        firstAudioPlayedMs: 1800,
        turnLatency: fullTurnLatency({ anchor: "eos", llmTtftMs: undefined, ttsTtfbMs: undefined }),
      });
      expect(message?.ttfaPlayedMs).toBe(600);
    });

    it("is omitted when playout was never reported", () => {
      const message = buildBrowserMetricsMessage("turn-no-playout", {
        ...emptyMarks(),
        speechEndMs: 1000,
        turnLatency: fullTurnLatency({ llmTtftMs: undefined, ttsTtfbMs: undefined }),
      });
      expect(message).not.toHaveProperty("ttfaPlayedMs");
    });
  });
});

describe("TurnMetricsTracker", () => {
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
      session.bus.push(Route.Media, {
        kind: "tts.audio", contextId, timestampMs: 1100, audio: new Uint8Array(640), sampleRateHz: 16000,
      });
    };

    it("does not pre-empt a client that reports playout, keeping the played marks", async () => {
      const session = new VoiceAgentSession({ plugins: {} });
      const emitted: BrowserMetricsMessage[] = [];
      const tracker = new TurnMetricsTracker(
        session, (m) => emitted.push(m), undefined, { finalizeOnTtsEnd: true },
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
      // The whole point: these survive, and ttfaPlayedMs is measured to audio
      // PLAYED, not to first byte — the same semantics the Node path reports.
      expect(message?.firstAudioPlayedMs).toBe(1200);
      expect(message?.lastAudioPlayedMs).toBe(4000);
      expect(message?.ttfaPlayedMs).toBe(700);

      await session.close();
    });

    it("floors on tts.end for a client that never reports playout", async () => {
      const session = new VoiceAgentSession({ plugins: {} });
      const emitted: BrowserMetricsMessage[] = [];
      const tracker = new TurnMetricsTracker(
        session, (m) => emitted.push(m), undefined, { finalizeOnTtsEnd: true },
      );
      tracker.wire([]);
      void session.start();

      driveTurnToTtsEnd(session, "silent");
      session.bus.push(Route.Main, { kind: "tts.end", contextId: "silent", timestampMs: 1300 });
      await waitForCondition(() => emitted.length === 1);

      const message = emitted[0];
      // The turn was measured (ttfaMs present) even though the finer llmTtftMs/
      // ttsTtfbMs stages raced ahead of the session's own bookkeeping — see the
      // transport-only firstAudioByteMs mark instead, which never depends on that.
      expect(message?.ttfaMs).toBeGreaterThan(0);
      expect(message?.firstAudioByteMs).toBe(1100);
      // Never measured, so omitted rather than zeroed.
      expect(message?.firstAudioPlayedMs).toBeUndefined();
      expect(message?.lastAudioPlayedMs).toBeUndefined();

      await session.close();
    });

    it("leaves the Node path alone — no floor unless opted in", async () => {
      const session = new VoiceAgentSession({ plugins: {} });
      const emitted: BrowserMetricsMessage[] = [];
      const tracker = new TurnMetricsTracker(session, (m) => emitted.push(m));
      tracker.wire([]);
      void session.start();

      driveTurnToTtsEnd(session, "node");
      session.bus.push(Route.Main, { kind: "tts.end", contextId: "node", timestampMs: 1300 });
      await new Promise((r) => setTimeout(r, 50));
      expect(emitted, "default must not finalize on tts.end").toHaveLength(0);

      await session.close();
    });
  });

  it("keeps correlation id stable for the turn context", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const emitted: BrowserMetricsMessage[] = [];
    const tracker = new TurnMetricsTracker(session, (message) => emitted.push(message));
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
      text: "hi there.",
    });
    // Let the Main-route llm.delta (which sets the session's internal firstLlmDeltaMs/
    // firstTtsTextMs) land before the Media-route tts.audio — Media drains on its own
    // loop and can otherwise race ahead of a same-tick Main backlog.
    await new Promise((resolve) => setTimeout(resolve, 10));
    session.bus.push(Route.Media, {
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
      llmTtftMs: 400,
      ttsTtfbMs: 200,
    });

    for (const dispose of disposers) dispose();
    await session.close();
  });

  it("records firstAudioPlayedMs from playout_started, not throttled progress", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const emitted: BrowserMetricsMessage[] = [];
    const tracker = new TurnMetricsTracker(session, (message) => emitted.push(message));
    const disposers: Array<() => void> = [];
    tracker.wire(disposers);
    void session.start();

    session.bus.push(Route.Main, {
      kind: "vad.speech_ended",
      contextId: "turn-throttle",
      timestampMs: 1000,
    });
    // A turn_latency measurement requires tts.audio (or tts.end) to anchor on — see
    // voice-agent-session.ts emitTurnLatency. Without it, this turn stays unmeasured
    // and buildBrowserMetricsMessage returns undefined regardless of playout marks.
    session.bus.push(Route.Media, {
      kind: "tts.audio",
      contextId: "turn-throttle",
      timestampMs: 1050,
      audio: new Uint8Array(640),
      sampleRateHz: 16000,
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
      ttfaPlayedMs: 100,
    });

    for (const dispose of disposers) dispose();
    await session.close();
  });

  it("emits metrics once when playout completes for a wired browser session", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const emitted: BrowserMetricsMessage[] = [];
    const tracker = new TurnMetricsTracker(session, (message) => emitted.push(message));
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
      text: "hi there.",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    session.bus.push(Route.Media, {
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
      llmTtftMs: 450,
      ttsTtfbMs: 150,
    });

    for (const dispose of disposers) dispose();
    await session.close();
  });

  it("drops partial turn state on interrupt without emitting metrics", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const emit = vi.fn();
    const tracker = new TurnMetricsTracker(session, emit);
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

  it("records metrics.unmeasured_turn instead of a zero-filled row when the session never measured a voice TTFA", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const emit = vi.fn();
    const unmeasured: unknown[] = [];
    const tracker = new TurnMetricsTracker(session, emit);
    const disposers: Array<() => void> = [];
    disposers.push(
      session.bus.on("metric.conversation", (pkt) => {
        const metric = pkt as ConversationMetricPacket;
        if (metric.name === "metrics.unmeasured_turn") unmeasured.push(metric);
      }),
    );
    tracker.wire(disposers);
    void session.start();

    // A text-injected turn: no vad.speech_ended / eos.turn_complete, so the session
    // never anchors a turn_latency for it (see voice-agent-session.ts emitTurnLatency).
    session.bus.push(Route.Main, { kind: "llm.delta", contextId: "text-turn", timestampMs: 1000, text: "hi there." });
    session.bus.push(Route.Media, {
      kind: "tts.audio", contextId: "text-turn", timestampMs: 1350, audio: new Uint8Array(640), sampleRateHz: 16000,
    });
    session.bus.push(Route.Main, {
      kind: "tts.playout_progress", contextId: "text-turn", timestampMs: 1500, playedOutMs: 100, complete: true,
    });

    await waitForCondition(() => unmeasured.length === 1);
    expect(emit).not.toHaveBeenCalled();
    expect(unmeasured[0]).toMatchObject({ contextId: "text-turn" });

    for (const dispose of disposers) dispose();
    await session.close();
  });
});

describe("turn metrics — endpointing decision", () => {
  it("emits the owner/reason when the turn state carries them", () => {
    const message = buildBrowserMetricsMessage("turn-dec", {
      ...emptyMarks(),
      endpointingOwner: "smart_turn",
      endpointingReason: "end_of_speech",
      turnLatency: fullTurnLatency({ llmTtftMs: undefined, ttsTtfbMs: undefined }),
    });
    expect(message?.endpointingOwner).toBe("smart_turn");
    expect(message?.endpointingReason).toBe("end_of_speech");
  });

  it("overrides the reason to force_finalized when the watchdog fired, even if the emitter said end_of_speech", () => {
    // The completing eos may come from the STT plugin, which cannot know the
    // force-finalize watchdog fired underneath it. The tracker reads that mark
    // independently, so the truth wins here regardless of emitter.
    const message = buildBrowserMetricsMessage("turn-forced", {
      ...emptyMarks(),
      endpointingOwner: "provider_stt",
      endpointingReason: "end_of_speech",
      forceFinalized: true,
      turnLatency: fullTurnLatency({ llmTtftMs: undefined, ttsTtfbMs: undefined }),
    });
    expect(message?.endpointingOwner).toBe("provider_stt");
    expect(message?.endpointingReason).toBe("force_finalized");
  });

  it("omits the decision when the state has none (absent means absent)", () => {
    const message = buildBrowserMetricsMessage("turn-none", {
      ...emptyMarks(),
      turnLatency: fullTurnLatency({ llmTtftMs: undefined, ttsTtfbMs: undefined }),
    });
    expect(message?.endpointingOwner).toBeUndefined();
    expect(message?.endpointingReason).toBeUndefined();
  });

  it("captures owner from the completing eos and force-finalize from the watchdog metric", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const emitted: BrowserMetricsMessage[] = [];
    const tracker = new TurnMetricsTracker(session, (m) => emitted.push(m));
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
    session.bus.push(Route.Media, {
      kind: "tts.audio",
      contextId: "turn-dec",
      timestampMs: 1100,
      audio: new Uint8Array(640),
      sampleRateHz: 16000,
    });
    // eos.turn_complete marks this context "generating", so emitTurnLatency defers
    // to tts.end rather than firing immediately at tts.audio.
    session.bus.push(Route.Main, { kind: "tts.end", contextId: "turn-dec", timestampMs: 1150 });
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
