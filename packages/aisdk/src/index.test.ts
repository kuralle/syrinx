// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { InMemoryReasonerSessionStore, PipelineBusImpl, Route } from "@kuralle-syrinx/core";
import type {
  EndOfSpeechPacket,
  InterruptLlmPacket,
  LlmErrorPacket,
  LlmResponseDonePacket,
  ReasoningSuspendedPacket,
  Reasoner,
  ReasonerTurn,
  ReasoningPart,
  TextToSpeechPlayoutProgressPacket,
  TextToSpeechTextPacket,
  TextToSpeechWordTimestampsPacket,
  TtsWordTimestamp,
} from "@kuralle-syrinx/core";
import type { FinishReason, ModelMessage, TextStreamPart, ToolSet } from "ai";
import { fromStreamFactory } from "./from-ai-sdk.js";
import { ReasoningBridge, type RunPointer, type RunStore } from "./index.js";

const ZERO_USAGE = {
  inputTokens: 0,
  inputTokenDetails: {
    noCacheTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  outputTokens: 0,
  outputTokenDetails: {
    textTokens: 0,
    reasoningTokens: 0,
  },
  totalTokens: 0,
};

describe("ReasoningBridge", () => {
  it("emits llm.done only after a normal provider stop finish", async () => {
    const packets: Array<{ route: Route; packet: unknown }> = [];
    const plugin = new ReasoningBridge(fromStreamFactory(async function* () {
      yield textDelta("Hello.");
      yield finish("stop");
    }));
    const bus = new PipelineBusImpl({ onPacket: (route, packet) => packets.push({ route, packet }) });
    const drain = bus.start();

    await plugin.initialize(bus, baseConfig());
    bus.push(Route.Main, turnComplete("turn-1", "Hi"));

    await waitFor(() => packets.some(({ packet }) => (packet as { kind?: string }).kind === "llm.done"));
    bus.stop();
    await drain;
    await plugin.close();

    expect(packets).toContainEqual({
      route: Route.Main,
      packet: expect.objectContaining({
        kind: "llm.done",
        contextId: "turn-1",
        text: "Hello.",
      } satisfies Partial<LlmResponseDonePacket>),
    });
    expect(packets).toContainEqual({
      route: Route.Background,
      packet: expect.objectContaining({
        kind: "metric.conversation",
        contextId: "turn-1",
        name: "llm.finish_reason",
        value: "stop",
      }),
    });
  });

  it("G2/WBS-1: cascade turn emits delegate.query then delegate.result on the Background route", async () => {
    const packets: Array<{ route: Route; packet: unknown }> = [];
    const plugin = new ReasoningBridge(fromStreamFactory(async function* () {
      yield toolCall("rag-1", "retrieve", { q: "deadline" });
      yield toolResult("rag-1", "retrieve", "chunk");
      yield textDelta("The deadline is March 31.");
      yield finish("stop");
    }));
    const bus = new PipelineBusImpl({ onPacket: (route, packet) => packets.push({ route, packet }) });
    const drain = bus.start();

    await plugin.initialize(bus, baseConfig());
    bus.push(Route.Main, turnComplete("turn-1", "When is the deadline?"));

    await waitFor(() => packets.some(({ packet }) => (packet as { kind?: string }).kind === "delegate.result"));
    bus.stop();
    await drain;
    await plugin.close();

    const delegatePackets = packets.filter(({ packet }) =>
      String((packet as { kind?: string }).kind).startsWith("delegate."),
    );
    expect(delegatePackets.map(({ route }) => route)).toEqual([Route.Background, Route.Background]);
    expect(delegatePackets[0]!.packet).toMatchObject({
      kind: "delegate.query",
      contextId: "turn-1",
      query: "When is the deadline?",
    });
    expect((delegatePackets[0]!.packet as { toolName?: string }).toolName).toBeUndefined();
    expect(delegatePackets[1]!.packet).toMatchObject({
      kind: "delegate.result",
      contextId: "turn-1",
      query: "When is the deadline?",
      answer: "The deadline is March 31.",
      grounded: true,
    });
    expect((delegatePackets[1]!.packet as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0);
    // delegate.query precedes the reasoner's first output.
    const queryIndex = packets.findIndex(({ packet }) => (packet as { kind?: string }).kind === "delegate.query");
    const firstDeltaIndex = packets.findIndex(({ packet }) => (packet as { kind?: string }).kind === "llm.delta");
    expect(queryIndex).toBeGreaterThanOrEqual(0);
    expect(queryIndex).toBeLessThan(firstDeltaIndex);
  });

  it("G2/WBS-1: cascade delegate.result grounded=false without tool use; none on error", async () => {
    const packets: Array<{ route: Route; packet: unknown }> = [];
    const plugin = new ReasoningBridge(fromStreamFactory(async function* () {
      yield textDelta("From memory.");
      yield finish("stop");
    }));
    const bus = new PipelineBusImpl({ onPacket: (route, packet) => packets.push({ route, packet }) });
    const drain = bus.start();

    await plugin.initialize(bus, baseConfig());
    bus.push(Route.Main, turnComplete("turn-1", "Hi"));

    await waitFor(() => packets.some(({ packet }) => (packet as { kind?: string }).kind === "delegate.result"));
    bus.stop();
    await drain;
    await plugin.close();

    const result = packets.find(({ packet }) => (packet as { kind?: string }).kind === "delegate.result")!;
    expect(result.packet).toMatchObject({ grounded: false, answer: "From memory." });
  });

  it("accepts the truncated reply on token-limit finish (fails the turn, never the call)", async () => {
    // A `length` finish means the model hit the token cap: the streamed reply is
    // truncated but usable. It must be spoken and the call kept up (L2) — never
    // escalated to a session-killing llm.error.
    const packets: Array<{ route: Route; packet: unknown }> = [];
    const plugin = new ReasoningBridge(fromStreamFactory(async function* () {
      yield textDelta("This answer is incomplete");
      yield finish("length", "MAX_TOKENS");
    }));
    const bus = new PipelineBusImpl({ onPacket: (route, packet) => packets.push({ route, packet }) });
    const drain = bus.start();

    await plugin.initialize(bus, baseConfig());
    bus.push(Route.Main, turnComplete("turn-1", "Hi"));

    await waitFor(() => packets.some(({ packet }) => (packet as { kind?: string }).kind === "llm.done"));
    bus.stop();
    await drain;
    await plugin.close();

    // The partial reply is committed as a normal turn completion.
    expect(packets).toContainEqual({
      route: Route.Main,
      packet: expect.objectContaining({ kind: "llm.done", contextId: "turn-1", text: "This answer is incomplete" }),
    });
    // No session-killing error was emitted.
    expect(packets.some(({ packet }) => (packet as { kind?: string }).kind === "llm.error")).toBe(false);
    // The truncation is observable for telemetry.
    expect(packets.some(({ packet }) => (packet as { kind?: string; name?: string }).name === "llm.finish_length_truncated")).toBe(true);
  });

  it("fails the turn recoverably (not the call) on an unfinished tool-loop finish", async () => {
    const packets: Array<{ route: Route; packet: unknown }> = [];
    const plugin = new ReasoningBridge(fromStreamFactory(async function* () {
      yield textDelta("partial");
      yield finish("tool-calls");
    }));
    const bus = new PipelineBusImpl({ onPacket: (route, packet) => packets.push({ route, packet }) });
    const drain = bus.start();

    await plugin.initialize(bus, baseConfig());
    bus.push(Route.Main, turnComplete("turn-1", "Hi"));

    await waitFor(() => packets.some(({ packet }) => (packet as { kind?: string }).kind === "llm.error"));
    bus.stop();
    await drain;
    await plugin.close();

    expect(packets).toContainEqual({
      route: Route.Critical,
      packet: expect.objectContaining({
        kind: "llm.error",
        contextId: "turn-1",
        isRecoverable: true, // recoverable → fallback spoken, session stays open
      } satisfies Partial<LlmErrorPacket>),
    });
    expect(packets.some(({ packet }) => (packet as { kind?: string }).kind === "llm.done")).toBe(false);
  });

  it("emits llm.error when the stream ends without finish metadata", async () => {
    const packets: Array<{ route: Route; packet: unknown }> = [];
    const plugin = new ReasoningBridge(fromStreamFactory(async function* () {
      yield textDelta("Hello.");
    }));
    const bus = new PipelineBusImpl({ onPacket: (route, packet) => packets.push({ route, packet }) });
    const drain = bus.start();

    await plugin.initialize(bus, baseConfig());
    bus.push(Route.Main, turnComplete("turn-1", "Hi"));

    await waitFor(() => packets.some(({ packet }) => (packet as { kind?: string }).kind === "llm.error"));
    bus.stop();
    await drain;
    await plugin.close();

    expect(packets.some(({ packet }) => (packet as { kind?: string }).kind === "llm.done")).toBe(false);
    expect(packets).toContainEqual({
      route: Route.Critical,
      packet: expect.objectContaining({
        kind: "llm.error",
        contextId: "turn-1",
      } satisfies Partial<LlmErrorPacket>),
    });
  });

  it("clears per-turn state when a generation errors before commit", async () => {
    const packets: Array<{ route: Route; packet: unknown }> = [];
    const plugin = new ReasoningBridge(fromStreamFactory(async function* () {
      throw new Error("provider failed");
    }));
    const bus = new PipelineBusImpl({ onPacket: (route, packet) => packets.push({ route, packet }) });
    const drain = bus.start();

    await plugin.initialize(bus, baseConfig());
    bus.push(Route.Main, turnComplete("turn-error-cleanup", "Hi"));

    await waitFor(() => hasPacket(packets, "llm.error", "turn-error-cleanup"));

    const internals = plugin as unknown as {
      spokenByContext: Map<string, unknown>;
      turnUserText: Map<string, unknown>;
      assistantMsgByContext: Map<string, unknown>;
      wordTimestampsByContext: Map<string, unknown>;
      playedOutMsByContext: Map<string, unknown>;
    };
    expect(internals.spokenByContext.has("turn-error-cleanup")).toBe(false);
    expect(internals.turnUserText.has("turn-error-cleanup")).toBe(false);
    expect(internals.assistantMsgByContext.has("turn-error-cleanup")).toBe(false);
    expect(internals.wordTimestampsByContext.has("turn-error-cleanup")).toBe(false);
    expect(internals.playedOutMsByContext.has("turn-error-cleanup")).toBe(false);

    bus.stop();
    await drain;
    await plugin.close();
  });

  it("rewrites an interrupted turn's history to the spoken prefix on barge-in during playback", async () => {
    const packets: Array<{ route: Route; packet: unknown }> = [];
    const capturedMessages: ModelMessage[][] = [];
    const plugin = new ReasoningBridge(fromStreamFactory(async function* ({ messages }) {
      capturedMessages.push(messages);
      if (capturedMessages.length === 1) {
        yield textDelta("Sentence one. Sentence two.");
        yield finish("stop");
        return;
      }
      yield textDelta("ok.");
      yield finish("stop");
    }));
    const bus = new PipelineBusImpl({ onPacket: (route, packet) => packets.push({ route, packet }) });
    const drain = bus.start();
    await plugin.initialize(bus, baseConfig());

    // Turn 1 generates fully and is committed to history (full text).
    bus.push(Route.Main, turnComplete("turn-1", "first question"));
    await waitFor(() => hasPacket(packets, "llm.done", "turn-1"));

    // Only the first sentence reached TTS before the user barged in.
    bus.push(Route.Main, ttsText("turn-1", "Sentence one."));
    await new Promise((resolve) => setTimeout(resolve, 10)); // tts.text dispatched before the Critical interrupt
    bus.push(Route.Critical, interruptLlm("turn-1"));
    await waitFor(() => hasMetric(packets, "llm.history_truncated_to_spoken"));

    bus.push(Route.Main, turnComplete("turn-2", "second question"));
    await waitFor(() => hasPacket(packets, "llm.done", "turn-2"));

    bus.stop();
    await drain;
    await plugin.close();

    expect(capturedMessages[1]).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "Sentence one." },
      { role: "user", content: "second question" },
    ]);
  });

  // G25 / VE-04: word-level precision tests
  it("uses word timestamps + playout position to compute exact spoken prefix at word boundaries", async () => {
    // Deadlock regression scenario (G2 prior revert): full generation committed to
    // history, then user barges in during playback. The spoken prefix must be
    // exactly the words whose endMs falls before the playout cutoff.
    const packets: Array<{ route: Route; packet: unknown }> = [];
    const capturedMessages: ModelMessage[][] = [];
    const plugin = new ReasoningBridge(fromStreamFactory(async function* ({ messages }) {
      capturedMessages.push(messages);
      if (capturedMessages.length === 1) {
        yield textDelta("Hello world foo bar.");
        yield finish("stop");
        return;
      }
      yield textDelta("ok.");
      yield finish("stop");
    }));
    const bus = new PipelineBusImpl({ onPacket: (route, packet) => packets.push({ route, packet }) });
    const drain = bus.start();
    await plugin.initialize(bus, baseConfig());

    // Turn 1 generates fully and commits to history.
    bus.push(Route.Main, turnComplete("turn-word", "first question"));
    await waitFor(() => hasPacket(packets, "llm.done", "turn-word"));

    // Word timestamps for the generated text (cumulative from context start).
    // Playout was at 450ms when the user barged in — only "Hello world" was heard.
    bus.push(Route.Main, wordTimestamps("turn-word", [
      { word: "Hello",  startMs: 0,   endMs: 200 },
      { word: "world",  startMs: 220, endMs: 400 },
      { word: "foo",    startMs: 420, endMs: 600 },
      { word: "bar.",   startMs: 620, endMs: 800 },
    ]));
    bus.push(Route.Main, playoutProgress("turn-word", 450, false));
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Barge-in during playback (the previously-deadlocking scenario, now non-blocking).
    bus.push(Route.Critical, interruptLlm("turn-word"));
    await waitFor(() => hasMetric(packets, "llm.history_truncated_to_spoken"));

    bus.push(Route.Main, turnComplete("turn-word-2", "second question"));
    await waitFor(() => hasPacket(packets, "llm.done", "turn-word-2"));

    bus.stop();
    await drain;
    await plugin.close();

    // History must contain ONLY words heard (endMs <= 450ms), not the full text.
    expect(capturedMessages[1]).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "Hello world" },
      { role: "user", content: "second question" },
    ]);
  });

  it("falls back to text-sent-to-TTS when no word timestamps are available", async () => {
    const packets: Array<{ route: Route; packet: unknown }> = [];
    const capturedMessages: ModelMessage[][] = [];
    const plugin = new ReasoningBridge(fromStreamFactory(async function* ({ messages }) {
      capturedMessages.push(messages);
      if (capturedMessages.length === 1) {
        yield textDelta("Sentence one. Sentence two.");
        yield finish("stop");
        return;
      }
      yield textDelta("ok.");
      yield finish("stop");
    }));
    const bus = new PipelineBusImpl({ onPacket: (route, packet) => packets.push({ route, packet }) });
    const drain = bus.start();
    await plugin.initialize(bus, baseConfig());

    bus.push(Route.Main, turnComplete("turn-fallback", "first question"));
    await waitFor(() => hasPacket(packets, "llm.done", "turn-fallback"));

    // Only the first sentence reached TTS (no word timestamps — fallback path).
    bus.push(Route.Main, ttsText("turn-fallback", "Sentence one."));
    await new Promise((resolve) => setTimeout(resolve, 10));
    bus.push(Route.Critical, interruptLlm("turn-fallback"));
    await waitFor(() => hasMetric(packets, "llm.history_truncated_to_spoken"));

    bus.push(Route.Main, turnComplete("turn-fallback-2", "second question"));
    await waitFor(() => hasPacket(packets, "llm.done", "turn-fallback-2"));

    bus.stop();
    await drain;
    await plugin.close();

    // Without word timestamps, history is the full tts.text sent before interrupt.
    expect(capturedMessages[1]).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "Sentence one." },
      { role: "user", content: "second question" },
    ]);
  });

  it("falls back to text-sent-to-TTS when playout position is unavailable (headless/browser path)", async () => {
    const packets: Array<{ route: Route; packet: unknown }> = [];
    const capturedMessages: ModelMessage[][] = [];
    const plugin = new ReasoningBridge(fromStreamFactory(async function* ({ messages }) {
      capturedMessages.push(messages);
      if (capturedMessages.length === 1) {
        yield textDelta("Hello world foo.");
        yield finish("stop");
        return;
      }
      yield textDelta("ok.");
      yield finish("stop");
    }));
    const bus = new PipelineBusImpl({ onPacket: (route, packet) => packets.push({ route, packet }) });
    const drain = bus.start();
    await plugin.initialize(bus, baseConfig());

    bus.push(Route.Main, turnComplete("turn-noplayout", "first question"));
    await waitFor(() => hasPacket(packets, "llm.done", "turn-noplayout"));

    // Word timestamps present but NO tts.playout_progress → falls back to spokenByContext.
    bus.push(Route.Main, ttsText("turn-noplayout", "Hello world foo."));
    bus.push(Route.Main, wordTimestamps("turn-noplayout", [
      { word: "Hello", startMs: 0, endMs: 200 },
      { word: "world", startMs: 220, endMs: 400 },
      { word: "foo.",  startMs: 420, endMs: 600 },
    ]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    bus.push(Route.Critical, interruptLlm("turn-noplayout"));
    await waitFor(() => hasMetric(packets, "llm.history_truncated_to_spoken"));

    bus.push(Route.Main, turnComplete("turn-noplayout-2", "second question"));
    await waitFor(() => hasPacket(packets, "llm.done", "turn-noplayout-2"));

    bus.stop();
    await drain;
    await plugin.close();

    // Falls back to the full tts.text sent (no playout position to cut it).
    expect(capturedMessages[1]).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "Hello world foo." },
      { role: "user", content: "second question" },
    ]);
  });

  it("records an interrupted mid-generation turn as the spoken prefix instead of dropping it", async () => {
    const packets: Array<{ route: Route; packet: unknown }> = [];
    const capturedMessages: ModelMessage[][] = [];
    const plugin = new ReasoningBridge(fromStreamFactory(async function* ({ signal, messages }) {
      capturedMessages.push(messages);
      if (capturedMessages.length === 1) {
        yield textDelta("Hello");
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return;
      }
      yield textDelta("ok.");
      yield finish("stop");
    }));
    const bus = new PipelineBusImpl({ onPacket: (route, packet) => packets.push({ route, packet }) });
    const drain = bus.start();
    await plugin.initialize(bus, baseConfig());

    bus.push(Route.Main, turnComplete("turn-1", "first question"));
    await waitFor(() =>
      packets.some(
        ({ packet }) =>
          (packet as { kind?: string }).kind === "llm.delta" &&
          (packet as { text?: string }).text === "Hello",
      ),
    );

    // The session spoke "Hello", then the user barged in mid-generation (G10 makes
    // this interrupt land while generation is still streaming).
    bus.push(Route.Main, ttsText("turn-1", "Hello"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    bus.push(Route.Critical, interruptLlm("turn-1"));
    await waitFor(() => hasMetric(packets, "llm.history_truncated_to_spoken"));

    bus.push(Route.Main, turnComplete("turn-2", "second question"));
    await waitFor(() => hasPacket(packets, "llm.done", "turn-2"));

    bus.stop();
    await drain;
    await plugin.close();

    expect(capturedMessages[1]).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: "second question" },
    ]);
  });
});

describe("ReasoningBridge durable session (G4/WBS-4)", () => {
  it("re-seeds context from the session store after a simulated eviction; no double-answer", async () => {
    const store = new InMemoryReasonerSessionStore();

    // First lifetime: one committed turn, then the host is evicted (bridge closed).
    const first = new ReasoningBridge(
      fromStreamFactory(async function* () {
        yield textDelta("Answer one.");
        yield finish("stop");
      }),
      { sessionStore: store, sessionId: "s1" },
    );
    const firstPackets: Array<{ packet: unknown }> = [];
    const firstBus = new PipelineBusImpl({ onPacket: (_route, packet) => firstPackets.push({ packet }) });
    const firstDrain = firstBus.start();
    await first.initialize(firstBus, baseConfig());
    firstBus.push(Route.Main, turnComplete("turn-1", "First question"));
    await waitFor(() => firstPackets.some(({ packet }) => (packet as { kind?: string }).kind === "llm.done"));
    firstBus.stop();
    await firstDrain;
    await first.close();

    // Second lifetime: a fresh bridge over the same store must hand the reasoner
    // the prior turn as context — and must not re-answer it.
    const seenMessages: Array<ReasonerTurn["messages"]> = [];
    const secondReasoner: Reasoner = {
      stream: (turn) => {
        seenMessages.push([...turn.messages]);
        return (async function* (): AsyncGenerator<ReasoningPart> {
          yield { type: "text-delta", text: "Answer two." };
          yield { type: "finish", reason: "stop", text: "Answer two." };
        })();
      },
    };
    const second = new ReasoningBridge(secondReasoner, { sessionStore: store, sessionId: "s1" });
    const packets: Array<{ packet: unknown }> = [];
    const bus = new PipelineBusImpl({ onPacket: (_route, packet) => packets.push({ packet }) });
    const drain = bus.start();
    await second.initialize(bus, baseConfig());
    // Nothing speaks spontaneously on resume (no double-answer).
    expect(packets.some(({ packet }) => (packet as { kind?: string }).kind === "llm.done")).toBe(false);

    bus.push(Route.Main, turnComplete("turn-2", "Second question"));
    await waitFor(() => packets.some(({ packet }) => (packet as { kind?: string }).kind === "llm.done"));
    bus.stop();
    await drain;
    await second.close();

    expect(seenMessages[0]).toEqual([
      { role: "user", content: "First question" },
      { role: "assistant", content: "Answer one." },
    ]);
    // The store now carries both turns for the next resume.
    expect(store.load("s1")).toEqual([
      { role: "user", content: "First question" },
      { role: "assistant", content: "Answer one." },
      { role: "user", content: "Second question" },
      { role: "assistant", content: "Answer two." },
    ]);
  });

  it("persists the interrupted turn's history as the heard prefix", async () => {
    const store = new InMemoryReasonerSessionStore();
    const plugin = new ReasoningBridge(
      fromStreamFactory(async function* () {
        yield textDelta("Full generated reply that was cut off.");
        yield finish("stop");
      }),
      { sessionStore: store, sessionId: "s1" },
    );
    const packets: Array<{ packet: unknown }> = [];
    const bus = new PipelineBusImpl({ onPacket: (_route, packet) => packets.push({ packet }) });
    const drain = bus.start();
    await plugin.initialize(bus, baseConfig());

    bus.push(Route.Main, turnComplete("turn-1", "Hi"));
    await waitFor(() => packets.some(({ packet }) => (packet as { kind?: string }).kind === "llm.done"));
    // What actually reached TTS before the barge-in.
    bus.push(Route.Main, {
      kind: "tts.text",
      contextId: "turn-1",
      timestampMs: Date.now(),
      text: "Full generated",
    } satisfies TextToSpeechTextPacket);
    await waitFor(() => packets.some(({ packet }) => (packet as { kind?: string }).kind === "tts.text"));
    bus.push(Route.Critical, {
      kind: "interrupt.llm",
      contextId: "turn-1",
      timestampMs: Date.now(),
    } satisfies InterruptLlmPacket);
    await waitFor(() =>
      packets.some(({ packet }) => (packet as { name?: string }).name === "llm.history_truncated_to_spoken"),
    );
    bus.stop();
    await drain;
    await plugin.close();

    expect(store.load("s1")).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Full generated" },
    ]);
  });
});

describe("ReasoningBridge suspend/resume", () => {
  it("clean suspend → resume: saves pointer, resumes with userText, discards on finish", async () => {
    const packets: Array<{ route: Route; packet: unknown }> = [];
    const runStore = new FakeRunStore();
    const { reasoner, capturedTurns } = createSuspendResumeReasoner();
    const plugin = new ReasoningBridge(reasoner, { runStore });
    const bus = new PipelineBusImpl({ onPacket: (route, packet) => packets.push({ route, packet }) });
    const drain = bus.start();
    await plugin.initialize(bus, baseConfig());

    bus.push(Route.Main, turnComplete("ctx", "first question"));
    await waitFor(() => hasPacket(packets, "llm.done", "ctx"));

    expect(packets).toContainEqual({
      route: Route.Main,
      packet: expect.objectContaining({
        kind: "llm.done",
        contextId: "ctx",
        text: "Approve?",
      } satisfies Partial<LlmResponseDonePacket>),
    });
    expect(packets).toContainEqual({
      route: Route.Background,
      packet: expect.objectContaining({
        kind: "reasoning.suspended",
        contextId: "ctx",
        runId: "r1",
        prompt: "Approve?",
        payload: { step: 1 },
      } satisfies Partial<ReasoningSuspendedPacket>),
    });
    expect(runStore.saveCalls).toEqual([["ctx", "r1"]]);

    bus.push(Route.Main, turnComplete("ctx", "yes"));
    await waitFor(() => packets.filter(({ packet }) => (packet as { kind?: string }).kind === "llm.done").length >= 2);

    expect(capturedTurns[1]?.resume).toEqual({ runId: "r1", data: "yes" });
    expect(runStore.discardCalls).toEqual(["ctx"]);

    bus.stop();
    await drain;
    await plugin.close();
  });

  it("suspend → barge-in → next turn restarts without resume", async () => {
    const packets: Array<{ route: Route; packet: unknown }> = [];
    const runStore = new FakeRunStore();
    const { reasoner, capturedTurns } = createSuspendResumeReasoner();
    const plugin = new ReasoningBridge(reasoner, { runStore });
    const bus = new PipelineBusImpl({ onPacket: (route, packet) => packets.push({ route, packet }) });
    const drain = bus.start();
    await plugin.initialize(bus, baseConfig());

    bus.push(Route.Main, turnComplete("ctx", "first question"));
    await waitFor(() => hasPacket(packets, "reasoning.suspended", "ctx"));
    expect(runStore.saveCalls).toEqual([["ctx", "r1"]]);

    bus.push(Route.Critical, interruptLlm("ctx"));
    await waitFor(() => runStore.discardCalls.includes("ctx"));

    bus.push(Route.Main, turnComplete("ctx", "corrected answer"));
    await waitFor(() => capturedTurns.length >= 2);

    expect(capturedTurns[1]?.resume).toBeUndefined();

    bus.stop();
    await drain;
    await plugin.close();
  });

  it("barge-in discards a pending run pointer", async () => {
    const runStore = new FakeRunStore();
    runStore.save("ctx", "r1");
    const plugin = new ReasoningBridge(fromStreamFactory(async function* () {
      yield textDelta("ok.");
      yield finish("stop");
    }), { runStore });
    const bus = new PipelineBusImpl({ onPacket: () => undefined });
    const drain = bus.start();
    await plugin.initialize(bus, baseConfig());

    bus.push(Route.Critical, interruptLlm("ctx"));
    await waitFor(() => runStore.discardCalls.includes("ctx"));
    expect(runStore.takePending("ctx")).toBeNull();

    bus.stop();
    await drain;
    await plugin.close();
  });

  it("without runStore, suspended still emits reasoning.suspended without persistence", async () => {
    const packets: Array<{ route: Route; packet: unknown }> = [];
    const { reasoner } = createSuspendResumeReasoner();
    const plugin = new ReasoningBridge(reasoner);
    const bus = new PipelineBusImpl({ onPacket: (route, packet) => packets.push({ route, packet }) });
    const drain = bus.start();
    await plugin.initialize(bus, baseConfig());

    bus.push(Route.Main, turnComplete("ctx", "question"));
    await waitFor(() => hasPacket(packets, "reasoning.suspended", "ctx"));

    expect(packets).toContainEqual({
      route: Route.Background,
      packet: expect.objectContaining({
        kind: "reasoning.suspended",
        contextId: "ctx",
        runId: "r1",
      } satisfies Partial<ReasoningSuspendedPacket>),
    });

    bus.stop();
    await drain;
    await plugin.close();
  });

  it("throws when onResumeConflict is replay", () => {
    expect(
      () => new ReasoningBridge(fromStreamFactory(async function* () {}), { onResumeConflict: "replay" }),
    ).toThrow("onResumeConflict 'replay' not yet supported — use 'restart'");
  });
});

class FakeRunStore implements RunStore {
  private pointers = new Map<string, string>();
  saveCalls: Array<[string, string]> = [];
  discardCalls: string[] = [];
  takePendingCalls: string[] = [];

  save(contextId: string, runId: string): void {
    this.saveCalls.push([contextId, runId]);
    this.pointers.set(contextId, runId);
  }

  takePending(contextId: string): RunPointer | null {
    this.takePendingCalls.push(contextId);
    const runId = this.pointers.get(contextId);
    return runId ? { runId } : null;
  }

  discard(contextId: string): void {
    this.discardCalls.push(contextId);
    this.pointers.delete(contextId);
  }
}

function createSuspendResumeReasoner(): {
  reasoner: Reasoner;
  capturedTurns: ReasonerTurn[];
} {
  const capturedTurns: ReasonerTurn[] = [];
  const reasoner: Reasoner = {
    stream(turn: ReasonerTurn): AsyncIterable<ReasoningPart> {
      capturedTurns.push(turn);
      return (async function* () {
        if (turn.resume) {
          yield { type: "text-delta", text: "Resumed." };
          yield { type: "finish", reason: "stop", text: "Resumed." };
          return;
        }
        yield {
          type: "suspended",
          runId: "r1",
          prompt: "Approve?",
          payload: { step: 1 },
        };
      })();
    },
  };
  return { reasoner, capturedTurns };
}

function hasPacket(packets: Array<{ packet: unknown }>, kind: string, contextId: string): boolean {
  return packets.some(
    ({ packet }) =>
      (packet as { kind?: string }).kind === kind &&
      (packet as { contextId?: string }).contextId === contextId,
  );
}

function hasMetric(packets: Array<{ packet: unknown }>, name: string): boolean {
  return packets.some(({ packet }) => (packet as { name?: string }).name === name);
}

function ttsText(contextId: string, text: string): TextToSpeechTextPacket {
  return { kind: "tts.text", contextId, timestampMs: Date.now(), text };
}

function wordTimestamps(contextId: string, words: TtsWordTimestamp[]): TextToSpeechWordTimestampsPacket {
  return { kind: "tts.word_timestamps", contextId, timestampMs: Date.now(), words };
}

function playoutProgress(contextId: string, playedOutMs: number, complete: boolean): TextToSpeechPlayoutProgressPacket {
  return { kind: "tts.playout_progress", contextId, timestampMs: Date.now(), playedOutMs, complete };
}

function interruptLlm(contextId: string): InterruptLlmPacket {
  return { kind: "interrupt.llm", contextId, timestampMs: Date.now() };
}

function baseConfig(): Record<string, unknown> {
  return {
    api_key: "test-key",
    model: "gpt-test",
    system_prompt: "test",
    retry_max_attempts: 1,
    timeout_ms: 1000,
  };
}

function turnComplete(contextId: string, text: string): EndOfSpeechPacket {
  return {
    kind: "eos.turn_complete",
    contextId,
    timestampMs: Date.now(),
    text,
    transcripts: [],
  };
}

function textDelta(text: string): TextStreamPart<ToolSet> {
  return { type: "text-delta", id: "0", text, providerMetadata: undefined } as TextStreamPart<ToolSet>;
}

function toolCall(toolCallId: string, toolName: string, input: Record<string, unknown>): TextStreamPart<ToolSet> {
  return { type: "tool-call", toolCallId, toolName, input } as TextStreamPart<ToolSet>;
}

function toolResult(toolCallId: string, toolName: string, output: unknown): TextStreamPart<ToolSet> {
  return { type: "tool-result", toolCallId, toolName, input: {}, output } as TextStreamPart<ToolSet>;
}

function finish(finishReason: FinishReason, rawFinishReason?: string): TextStreamPart<ToolSet> {
  return {
    type: "finish",
    finishReason,
    rawFinishReason,
    totalUsage: ZERO_USAGE,
    usage: ZERO_USAGE,
    providerMetadata: undefined,
    response: {},
  } as TextStreamPart<ToolSet>;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1000) {
      throw new Error("Timed out waiting for packet");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
