// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { PipelineBusImpl, Route } from "@asyncdot/voice";
import type {
  EndOfSpeechPacket,
  InterruptLlmPacket,
  LlmErrorPacket,
  LlmResponseDonePacket,
  TextToSpeechPlayoutProgressPacket,
  TextToSpeechTextPacket,
  TextToSpeechWordTimestampsPacket,
  TtsWordTimestamp,
} from "@asyncdot/voice";
import type { FinishReason, ModelMessage, TextStreamPart, ToolSet } from "ai";
import { AISDKBridgePlugin } from "./index.js";

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

describe("AISDKBridgePlugin", () => {
  it("emits llm.done only after a normal provider stop finish", async () => {
    const packets: Array<{ route: Route; packet: unknown }> = [];
    const plugin = new AISDKBridgePlugin(async function* () {
      yield textDelta("Hello.");
      yield finish("stop");
    });
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

  it("emits llm.error instead of llm.done when provider reaches token limit", async () => {
    const packets: Array<{ route: Route; packet: unknown }> = [];
    const plugin = new AISDKBridgePlugin(async function* () {
      yield textDelta("This answer is incomplete");
      yield finish("length", "MAX_TOKENS");
    });
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
        isRecoverable: false,
      } satisfies Partial<LlmErrorPacket>),
    });
  });

  it("emits llm.error when the stream ends without finish metadata", async () => {
    const packets: Array<{ route: Route; packet: unknown }> = [];
    const plugin = new AISDKBridgePlugin(async function* () {
      yield textDelta("Hello.");
    });
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
    const plugin = new AISDKBridgePlugin(async function* () {
      throw new Error("provider failed");
    });
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
    const plugin = new AISDKBridgePlugin(async function* ({ messages }) {
      capturedMessages.push(messages);
      if (capturedMessages.length === 1) {
        yield textDelta("Sentence one. Sentence two.");
        yield finish("stop");
        return;
      }
      yield textDelta("ok.");
      yield finish("stop");
    });
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
    const plugin = new AISDKBridgePlugin(async function* ({ messages }) {
      capturedMessages.push(messages);
      if (capturedMessages.length === 1) {
        yield textDelta("Hello world foo bar.");
        yield finish("stop");
        return;
      }
      yield textDelta("ok.");
      yield finish("stop");
    });
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
    const plugin = new AISDKBridgePlugin(async function* ({ messages }) {
      capturedMessages.push(messages);
      if (capturedMessages.length === 1) {
        yield textDelta("Sentence one. Sentence two.");
        yield finish("stop");
        return;
      }
      yield textDelta("ok.");
      yield finish("stop");
    });
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
    const plugin = new AISDKBridgePlugin(async function* ({ messages }) {
      capturedMessages.push(messages);
      if (capturedMessages.length === 1) {
        yield textDelta("Hello world foo.");
        yield finish("stop");
        return;
      }
      yield textDelta("ok.");
      yield finish("stop");
    });
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
    const plugin = new AISDKBridgePlugin(async function* ({ signal, messages }) {
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
    });
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
