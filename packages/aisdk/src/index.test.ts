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
  ReasonerPrewarmContext,
  ReasonerTurn,
  ReasoningPart,
  TextToSpeechPlayoutProgressPacket,
  TextToSpeechTextPacket,
  TextToSpeechWordTimestampsPacket,
  TtsWordTimestamp,
  SttResultPacket,
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
  it("adds transient context to the next turn without replacing or persisting the base prompt", async () => {
    const store = new InMemoryReasonerSessionStore();
    store.save("session-1", [{ role: "system", content: "Base policy." }]);
    const seenMessages: ReasonerTurn["messages"][] = [];
    const reasoner: Reasoner = {
      stream: (turn) => {
        seenMessages.push([...turn.messages]);
        return (async function* (): AsyncGenerator<ReasoningPart> {
          yield { type: "text-delta", text: "Acknowledged." };
          yield { type: "finish", reason: "stop", text: "Acknowledged." };
        })();
      },
    };
    const plugin = new ReasoningBridge(reasoner, { sessionStore: store, sessionId: "session-1" });
    const bus = new PipelineBusImpl();
    const drain = bus.start();
    await plugin.initialize(bus, baseConfig());

    plugin.injectContext("Correction: use the verified deadline.");
    bus.push(Route.Main, turnComplete("turn-context", "What is the deadline?"));
    await waitFor(() => seenMessages.length === 1);

    expect(seenMessages[0]).toEqual([
      { role: "system", content: "Base policy." },
      { role: "system", content: "Correction: use the verified deadline." },
    ]);
    await waitFor(() => store.load("session-1").some((message) => message.role === "assistant"));
    expect(store.load("session-1")).toEqual([
      { role: "system", content: "Base policy." },
      { role: "user", content: "What is the deadline?" },
      { role: "assistant", content: "Acknowledged." },
    ]);

    bus.stop();
    await drain;
    await plugin.close();
  });

  it("emits LLM call-count and per-pass TTFT metrics", async () => {
    const packets: Array<{ route: Route; packet: unknown }> = [];
    const plugin = new ReasoningBridge(fromStreamFactory(async function* () {
      yield textDelta("Hello.");
      yield finish("stop");
    }));
    const bus = new PipelineBusImpl({ onPacket: (route, packet) => packets.push({ route, packet }) });
    const drain = bus.start();

    await plugin.initialize(bus, baseConfig());
    bus.push(Route.Main, turnComplete("turn-metrics", "Hi"));
    await waitFor(() => packets.some(({ packet }) => (packet as { kind?: string }).kind === "llm.done"));
    await waitFor(() => packets.filter(({ packet }) => (packet as { name?: string }).name === "llm.pass_ttft_ms").length === 1);

    const metrics = packets.filter(({ packet }) => (packet as { kind?: string }).kind === "metric.conversation");
    expect(metrics.filter(({ packet }) => (packet as { name?: string }).name === "llm.call_started")).toHaveLength(1);
    expect(metrics.filter(({ packet }) => (packet as { name?: string }).name === "llm.pass_ttft_ms").map(({ packet }) => packet)).toEqual([
      expect.objectContaining({ contextId: "turn-metrics", value: expect.stringMatching(/^\d+(\.\d+)?$/) }),
    ]);

    bus.stop();
    await drain;
    await plugin.close();
  });

  it("counts sequential tool-loop inference passes and records each pass TTFT", async () => {
    const packets: Array<{ route: Route; packet: unknown }> = [];
    const plugin = new ReasoningBridge(fromStreamFactory(async function* () {
      yield toolCall("call-1", "retrieve", { q: "fees" });
      yield toolResult("call-1", "retrieve", "ten dollars");
      yield textDelta("The fee is ten dollars.");
      yield finish("stop");
    }));
    const bus = new PipelineBusImpl({ onPacket: (route, packet) => packets.push({ route, packet }) });
    const drain = bus.start();

    await plugin.initialize(bus, baseConfig());
    bus.push(Route.Main, turnComplete("turn-two-passes", "What is the fee?"));
    await waitFor(() => packets.some(({ packet }) => (packet as { kind?: string }).kind === "llm.done"));
    await waitFor(() => packets.filter(({ packet }) => (packet as { name?: string }).name === "llm.pass_ttft_ms").length === 2);

    const metrics = packets.filter(({ packet }) => (packet as { kind?: string }).kind === "metric.conversation");
    expect(metrics.filter(({ packet }) => (packet as { name?: string }).name === "llm.call_started")).toHaveLength(2);
    expect(metrics.filter(({ packet }) => (packet as { name?: string }).name === "llm.pass_ttft_ms")).toHaveLength(2);

    bus.stop();
    await drain;
    await plugin.close();
  });

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

  it("forwards control parts and continues to the final answer", async () => {
    const packets: Array<{ route: Route; packet: unknown }> = [];
    const reasoner: Reasoner = {
      stream: async function* () {
        yield { type: "control", name: "handoff", payload: { targetAgent: "billing" } };
        yield { type: "text-delta", text: "The billing team can help." };
        yield { type: "finish", reason: "stop", text: "The billing team can help." };
      },
    };
    const plugin = new ReasoningBridge(reasoner);
    const bus = new PipelineBusImpl({ onPacket: (route, packet) => packets.push({ route, packet }) });
    const drain = bus.start();

    await plugin.initialize(bus, baseConfig());
    bus.push(Route.Main, turnComplete("turn-control", "Please transfer me."));
    await waitFor(() => packets.some(({ packet }) => (packet as { kind?: string }).kind === "llm.done"));

    expect(packets).toContainEqual({
      route: Route.Background,
      packet: expect.objectContaining({
        kind: "delegate.result",
        control: { name: "handoff", payload: { targetAgent: "billing" } },
      }),
    });
    expect(packets).toContainEqual({
      route: Route.Main,
      packet: expect.objectContaining({ kind: "llm.done", text: "The billing team can help." }),
    });

    bus.stop();
    await drain;
    await plugin.close();
  });

  it("speaks a blocked part and ends the turn without an LLM error", async () => {
    const packets: Array<{ route: Route; packet: unknown }> = [];
    const reasoner: Reasoner = {
      stream: async function* () {
        yield { type: "blocked", userFacingMessage: "I cannot help with that request.", payload: { moderator: "safety" } };
      },
    };
    const plugin = new ReasoningBridge(reasoner);
    const bus = new PipelineBusImpl({ onPacket: (route, packet) => packets.push({ route, packet }) });
    const drain = bus.start();

    await plugin.initialize(bus, baseConfig());
    bus.push(Route.Main, turnComplete("turn-blocked", "Unsafe request"));
    await waitFor(() => packets.some(({ packet }) => (packet as { kind?: string }).kind === "llm.done"));

    expect(packets).toContainEqual({
      route: Route.Main,
      packet: expect.objectContaining({ kind: "llm.delta", text: "I cannot help with that request." }),
    });
    expect(packets).toContainEqual({
      route: Route.Background,
      packet: expect.objectContaining({
        kind: "delegate.result",
        answer: "I cannot help with that request.",
        blocked: expect.objectContaining({ userFacingMessage: "I cannot help with that request." }),
      }),
    });
    expect(packets.some(({ packet }) => (packet as { kind?: string }).kind === "llm.error")).toBe(false);

    bus.stop();
    await drain;
    await plugin.close();
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

function eosInterim(contextId: string, text: string): { kind: "eos.interim"; contextId: string; timestampMs: number; text: string } {
  return { kind: "eos.interim", contextId, timestampMs: Date.now(), text };
}

function eosRetracted(contextId: string): { kind: "eos.retracted"; contextId: string; timestampMs: number } {
  return { kind: "eos.retracted", contextId, timestampMs: Date.now() };
}

describe("ReasoningBridge speculative generation", () => {
  function kinds(packets: Array<{ packet: unknown }>): string[] {
    return packets.map(({ packet }) => (packet as { kind: string }).kind);
  }

  it("buffers a draft on eos.interim and flushes it on a matching eos.turn_complete (one generation)", async () => {
    const packets: Array<{ route: Route; packet: unknown }> = [];
    let streams = 0;
    const plugin = new ReasoningBridge(
      fromStreamFactory(async function* () {
        streams += 1;
        yield textDelta("The fee is ten dollars.");
        yield finish("stop");
      }),
      { speculative: true },
    );
    const bus = new PipelineBusImpl({ onPacket: (route, packet) => packets.push({ route, packet }) });
    const drain = bus.start();
    await plugin.initialize(bus, baseConfig());

    bus.push(Route.Main, eosInterim("turn-1", "what are the lab fees"));
    // Give the draft time to stream fully — nothing may reach the bus yet.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(kinds(packets)).not.toContain("llm.delta");
    expect(kinds(packets)).not.toContain("llm.done");
    expect(kinds(packets)).not.toContain("delegate.query");

    bus.push(Route.Main, turnComplete("turn-1", "what are the lab fees"));
    await waitFor(() => kinds(packets).includes("llm.done"));
    bus.stop();
    await drain;
    await plugin.close();

    expect(streams).toBe(1); // the draft WAS the generation — no second LLM call
    expect(packets).toContainEqual({
      route: Route.Main,
      packet: expect.objectContaining({ kind: "llm.delta", contextId: "turn-1", text: "The fee is ten dollars." }),
    });
    expect(packets).toContainEqual({
      route: Route.Background,
      packet: expect.objectContaining({ kind: "delegate.result", contextId: "turn-1", answer: "The fee is ten dollars." }),
    });
  });

  it("discards the draft on eos.retracted — nothing is ever pushed for it", async () => {
    const packets: Array<{ route: Route; packet: unknown }> = [];
    let streams = 0;
    const plugin = new ReasoningBridge(
      fromStreamFactory(async function* () {
        streams += 1;
        yield textDelta("Draft answer.");
        yield finish("stop");
      }),
      { speculative: true },
    );
    const bus = new PipelineBusImpl({ onPacket: (route, packet) => packets.push({ route, packet }) });
    const drain = bus.start();
    await plugin.initialize(bus, baseConfig());

    bus.push(Route.Main, eosInterim("turn-1", "book a"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    bus.push(Route.Main, eosRetracted("turn-1"));
    await new Promise((resolve) => setTimeout(resolve, 30));

    // The user finishes the real utterance later; a fresh generation answers it.
    bus.push(Route.Main, turnComplete("turn-1", "book a room for tomorrow"));
    await waitFor(() => kinds(packets).includes("llm.done"));
    bus.stop();
    await drain;
    await plugin.close();

    expect(streams).toBe(2); // draft + fresh confirmed run
    const deltas = packets.filter(({ packet }) => (packet as { kind: string }).kind === "llm.delta");
    expect(deltas).toHaveLength(1); // the discarded draft's delta never surfaced
  });

  it("regenerates when the confirmed transcript differs from the draft's", async () => {
    const packets: Array<{ route: Route; packet: unknown }> = [];
    const seenTexts: string[] = [];
    const plugin = new ReasoningBridge(
      fromStreamFactory(async function* (request: { userText: string }) {
        seenTexts.push(request.userText);
        yield textDelta(`Answer to: ${request.userText}`);
        yield finish("stop");
      }),
      { speculative: true },
    );
    const bus = new PipelineBusImpl({ onPacket: (route, packet) => packets.push({ route, packet }) });
    const drain = bus.start();
    await plugin.initialize(bus, baseConfig());

    bus.push(Route.Main, eosInterim("turn-1", "what are the"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    bus.push(Route.Main, turnComplete("turn-1", "what are the lab fees"));
    await waitFor(() => kinds(packets).includes("llm.done"));
    bus.stop();
    await drain;
    await plugin.close();

    expect(seenTexts).toEqual(["what are the", "what are the lab fees"]);
    expect(packets).toContainEqual({
      route: Route.Main,
      packet: expect.objectContaining({ kind: "llm.done", text: "Answer to: what are the lab fees" }),
    });
    const deltas = packets.filter(({ packet }) => (packet as { kind: string }).kind === "llm.delta");
    expect(deltas).toHaveLength(1);
  });

  it("ignores eos.interim when speculative mode is off (default)", async () => {
    const packets: Array<{ route: Route; packet: unknown }> = [];
    let streams = 0;
    const plugin = new ReasoningBridge(
      fromStreamFactory(async function* () {
        streams += 1;
        yield textDelta("Hello.");
        yield finish("stop");
      }),
    );
    const bus = new PipelineBusImpl({ onPacket: (route, packet) => packets.push({ route, packet }) });
    const drain = bus.start();
    await plugin.initialize(bus, baseConfig());

    bus.push(Route.Main, eosInterim("turn-1", "hi"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    bus.stop();
    await drain;
    await plugin.close();

    expect(streams).toBe(0);
    expect(kinds(packets).filter((k) => k.startsWith("llm."))).toHaveLength(0);
  });

  it("emits speculative draft lifecycle metrics for promotion and discard", async () => {
    const packets: Array<{ route: Route; packet: unknown }> = [];
    const plugin = new ReasoningBridge(
      fromStreamFactory(async function* () {
        yield textDelta("Draft.");
        yield finish("stop");
      }),
      { speculative: true },
    );
    const bus = new PipelineBusImpl({ onPacket: (route, packet) => packets.push({ route, packet }) });
    const drain = bus.start();
    await plugin.initialize(bus, baseConfig());

    bus.push(Route.Main, eosInterim("turn-spec-metrics", "hello"));
    await waitFor(() => metricNames(packets).includes("speculative.draft_started"));
    bus.push(Route.Main, eosInterim("turn-spec-metrics", "hello there"));
    await waitFor(() => metricNames(packets).includes("speculative.draft_discarded"));
    bus.push(Route.Main, turnComplete("turn-spec-metrics", "hello there"));
    await waitFor(() => metricNames(packets).includes("speculative.draft_promoted"));

    expect(metricNames(packets)).toEqual([
      "speculative.draft_started",
      "speculative.draft_discarded",
      "speculative.draft_started",
      "speculative.draft_promoted",
    ]);

    bus.stop();
    await drain;
    await plugin.close();
  });
});

describe("ReasoningBridge.prewarm", () => {
  it("forwards session context to reasoner.prewarm", async () => {
    const seen: ReasonerPrewarmContext[] = [];
    const reasoner: Reasoner = {
      async prewarm(ctx) {
        seen.push(ctx);
      },
      stream: () =>
        (async function* (): AsyncGenerator<ReasoningPart> {
          yield { type: "finish", reason: "stop", text: "" };
        })(),
    };
    const store = new InMemoryReasonerSessionStore();
    store.save("session-1", [{ role: "system", content: "Base policy." }]);
    const plugin = new ReasoningBridge(reasoner, { sessionStore: store, sessionId: "session-1" });
    const bus = new PipelineBusImpl();
    const drain = bus.start();
    await plugin.initialize(bus, baseConfig());
    await plugin.prewarm();
    expect(seen).toEqual([
      {
        sessionId: "session-1",
        systemPrompt: "Base policy.",
        seedMessages: [{ role: "system", content: "Base policy." }],
      },
    ]);
    bus.stop();
    await drain;
    await plugin.close();
  });

  it("times out a hanging reasoner prewarm", async () => {
    const reasoner: Reasoner = {
      prewarm: () => new Promise(() => {}),
      stream: () =>
        (async function* (): AsyncGenerator<ReasoningPart> {
          yield { type: "finish", reason: "stop", text: "" };
        })(),
    };
    const plugin = new ReasoningBridge(reasoner);
    const bus = new PipelineBusImpl();
    const drain = bus.start();
    await plugin.initialize(bus, { ...baseConfig(), prewarm_timeout_ms: 50 });
    const started = Date.now();
    await expect(plugin.prewarm()).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(500);
    bus.stop();
    await drain;
    await plugin.close();
  });

  it("skips when reasoner has no prewarm", async () => {
    const reasoner: Reasoner = {
      stream: () =>
        (async function* (): AsyncGenerator<ReasoningPart> {
          yield { type: "finish", reason: "stop", text: "" };
        })(),
    };
    const plugin = new ReasoningBridge(reasoner);
    const bus = new PipelineBusImpl();
    const drain = bus.start();
    await plugin.initialize(bus, baseConfig());
    await expect(plugin.prewarm()).resolves.toBeUndefined();
    bus.stop();
    await drain;
    await plugin.close();
  });

  it("records accumulated user text across multiple STT finals in history", async () => {
    const store = new InMemoryReasonerSessionStore();
    const reasoner: Reasoner = {
      stream: () =>
        (async function* (): AsyncGenerator<ReasoningPart> {
          yield { type: "text-delta", text: "Got it." };
          yield { type: "finish", reason: "stop", text: "Got it." };
        })(),
    };
    const plugin = new ReasoningBridge(reasoner, { sessionStore: store, sessionId: "session-accum" });
    const bus = new PipelineBusImpl();
    const drain = bus.start();
    await plugin.initialize(bus, baseConfig());

    const ctx = "turn-multi-final";
    bus.push(Route.Main, {
      kind: "stt.result",
      contextId: ctx,
      timestampMs: Date.now(),
      text: "Does Biology 101 have a separate lab fee",
      confidence: 0.95,
    } satisfies SttResultPacket);
    bus.push(Route.Main, {
      kind: "stt.result",
      contextId: ctx,
      timestampMs: Date.now() + 1,
      text: "because that changes how I plan my payment.",
      confidence: 0.95,
    } satisfies SttResultPacket);
    bus.push(Route.Main, turnComplete(ctx, "because that changes how I plan my payment."));
    await waitFor(() => store.load("session-accum").some((m) => m.role === "assistant"));

    const userMessage = store.load("session-accum").find((m) => m.role === "user");
    expect(userMessage?.content).toContain("lab fee");
    expect(userMessage?.content).toContain("payment");

    bus.stop();
    await drain;
    await plugin.close();
  });
});

function baseConfig(): Record<string, unknown> {
  return {
    api_key: "test-key",
    model: "gpt-test",
    system_prompt: "test",
    retry_max_attempts: 1,
    timeout_ms: 1000,
  };
}

function metricNames(packets: Array<{ packet: unknown }>): string[] {
  return packets
    .filter(({ packet }) => (packet as { kind?: string }).kind === "metric.conversation")
    .map(({ packet }) => (packet as { name: string }).name)
    .filter((name) => name.startsWith("speculative."));
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
