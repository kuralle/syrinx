// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
  PipelineBusImpl,
  Route,
  type EndOfSpeechPacket,
  type InMemoryIuLedger,
  type IncrementalUnitId,
  type InterruptLlmPacket,
  type TextToSpeechPlayoutProgressPacket,
  type TextToSpeechTextPacket,
  type TextToSpeechWordTimestampsPacket,
  type TtsWordTimestamp,
} from "@kuralle-syrinx/core";
import type { FinishReason, TextStreamPart, ToolSet } from "ai";
import { fromStreamFactory } from "./from-ai-sdk.js";
import { ReasoningBridge } from "./index.js";

const ZERO_USAGE = {
  inputTokens: 0,
  inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokens: 0,
  outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
  totalTokens: 0,
};

type BridgeLedgerAccess = {
  iuLedger: InMemoryIuLedger;
};

function bridgeLedger(plugin: ReasoningBridge): BridgeLedgerAccess {
  return plugin as unknown as BridgeLedgerAccess;
}

function assistantId(contextId: string, epoch = 1): IncrementalUnitId {
  return { contextId, iuId: `${contextId}#assistant`, epoch };
}

function userTurnId(contextId: string, epoch = 1): IncrementalUnitId {
  return { contextId, iuId: contextId, epoch };
}

describe("ReasoningBridge heard-prefix commit (S2-01)", () => {
  it("commits assistant IU with word-boundary prefix on barge-in during playback", async () => {
    const packets: Array<{ packet: unknown }> = [];
    const plugin = new ReasoningBridge(
      fromStreamFactory(async function* () {
        yield textDelta("Hello world foo bar.");
        yield finish("stop");
      }),
    );
    const bus = new PipelineBusImpl({ onPacket: (_route, packet) => packets.push({ packet }) });
    const drain = bus.start();
    await plugin.initialize(bus, baseConfig());
    const ledger = bridgeLedger(plugin);
    const ctx = "turn-word";

    bus.push(Route.Main, turnComplete(ctx, "first question"));
    await waitFor(() => hasPacket(packets, "llm.done", ctx));

    bus.push(Route.Main, wordTimestamps(ctx, [
      { word: "Hello", startMs: 0, endMs: 200 },
      { word: "world", startMs: 220, endMs: 400 },
      { word: "foo", startMs: 420, endMs: 600 },
      { word: "bar.", startMs: 620, endMs: 800 },
    ]));
    bus.push(Route.Main, playoutProgress(ctx, 450));
    await new Promise((resolve) => setTimeout(resolve, 20));

    bus.push(Route.Critical, interruptLlm(ctx));
    await waitFor(() => hasMetric(packets, "llm.history_truncated_to_spoken"));

    const spoken = "Hello world";
    const iu = ledger.iuLedger.get(assistantId(ctx))!;
    expect(iu.state).toBe("committed");
    expect(iu.committedPrefix?.chars).toBe(spoken.length);
    expect(iu.committedPrefix?.ms).toBe(450);
    expect(iu.committedPrefix?.chars).toBeLessThan("Hello world foo bar.".length);

    bus.stop();
    await drain;
    await plugin.close();
  });

  it("commits assistant IU with spokenByContext prefix when word timestamps are absent", async () => {
    const packets: Array<{ packet: unknown }> = [];
    const plugin = new ReasoningBridge(
      fromStreamFactory(async function* () {
        yield textDelta("Sentence one. Sentence two.");
        yield finish("stop");
      }),
    );
    const bus = new PipelineBusImpl({ onPacket: (_route, packet) => packets.push({ packet }) });
    const drain = bus.start();
    await plugin.initialize(bus, baseConfig());
    const ledger = bridgeLedger(plugin);
    const ctx = "turn-fallback";

    bus.push(Route.Main, turnComplete(ctx, "first question"));
    await waitFor(() => hasPacket(packets, "llm.done", ctx));

    bus.push(Route.Main, ttsText(ctx, "Sentence one."));
    await new Promise((resolve) => setTimeout(resolve, 10));
    bus.push(Route.Critical, interruptLlm(ctx));
    await waitFor(() => hasMetric(packets, "llm.history_truncated_to_spoken"));

    const spoken = "Sentence one.";
    const iu = ledger.iuLedger.get(assistantId(ctx))!;
    expect(iu.state).toBe("committed");
    expect(iu.committedPrefix?.chars).toBe(spoken.length);

    bus.stop();
    await drain;
    await plugin.close();
  });

  it("commits heard prefix on mid-stream interrupt without losing streamed packets", async () => {
    const packets: Array<{ route: Route; packet: unknown }> = [];
    const plugin = new ReasoningBridge(
      fromStreamFactory(async function* ({ signal }) {
        yield textDelta("Hello");
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }),
    );
    const bus = new PipelineBusImpl({ onPacket: (route, packet) => packets.push({ route, packet }) });
    const drain = bus.start();
    await plugin.initialize(bus, baseConfig());
    const ledger = bridgeLedger(plugin);
    const ctx = "turn-mid";

    bus.push(Route.Main, turnComplete(ctx, "first question"));
    await waitFor(() =>
      packets.some(
        ({ packet }) =>
          (packet as { kind?: string }).kind === "llm.delta" &&
          (packet as { text?: string }).text === "Hello",
      ),
    );

    bus.push(Route.Main, ttsText(ctx, "Hello"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    bus.push(Route.Critical, interruptLlm(ctx));
    await waitFor(() => hasMetric(packets, "llm.history_truncated_to_spoken"));

    const iu = ledger.iuLedger.get(assistantId(ctx))!;
    expect(iu.state).toBe("committed");
    expect(iu.committedPrefix?.chars).toBe("Hello".length);

    expect(packets).toContainEqual({
      route: Route.Main,
      packet: expect.objectContaining({ kind: "llm.delta", contextId: ctx, text: "Hello" }),
    });
    expect(packets.some(({ packet }) => (packet as { kind?: string }).kind === "llm.done")).toBe(false);

    bus.stop();
    await drain;
    await plugin.close();
  });

  it("commits assistant IU fully on clean completion without a truncated prefix", async () => {
    const packets: Array<{ packet: unknown }> = [];
    const plugin = new ReasoningBridge(
      fromStreamFactory(async function* () {
        yield textDelta("Clean answer.");
        yield finish("stop");
      }),
    );
    const bus = new PipelineBusImpl({ onPacket: (_route, packet) => packets.push({ packet }) });
    const drain = bus.start();
    await plugin.initialize(bus, baseConfig());
    const ledger = bridgeLedger(plugin);
    const ctx = "turn-clean";

    bus.push(Route.Main, turnComplete(ctx, "question"));
    await waitFor(() => hasPacket(packets, "llm.done", ctx));

    const iu = ledger.iuLedger.get(assistantId(ctx))!;
    expect(iu.state).toBe("committed");
    expect(iu.committedPrefix).toBeUndefined();

    bus.stop();
    await drain;
    await plugin.close();
  });

  it("keeps distinct assistant and user-turn IUs in the ledger for one contextId", async () => {
    const plugin = new ReasoningBridge(
      fromStreamFactory(async function* () {
        yield textDelta("Answer.");
        yield finish("stop");
      }),
      { speculative: true },
    );
    const bus = new PipelineBusImpl({ onPacket: () => {} });
    const drain = bus.start();
    await plugin.initialize(bus, baseConfig());
    const ledger = bridgeLedger(plugin);
    const ctx = "turn-dual";

    bus.push(Route.Main, eosInterim(ctx, "hello"));
    await new Promise((resolve) => setTimeout(resolve, 30));

    const userIu = ledger.iuLedger.get(userTurnId(ctx));
    const assistantIu = ledger.iuLedger.get(assistantId(ctx));
    expect(userIu?.kind).toBe("user_turn");
    expect(assistantIu?.kind).toBe("assistant_response");
    expect(userIu?.id.iuId).toBe(ctx);
    expect(assistantIu?.id.iuId).toBe(`${ctx}#assistant`);
    expect(userIu?.id.epoch).toBe(assistantIu?.id.epoch);

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

function turnComplete(contextId: string, text: string): EndOfSpeechPacket {
  return { kind: "eos.turn_complete", contextId, timestampMs: Date.now(), text, transcripts: [] };
}

function eosInterim(contextId: string, text: string): { kind: "eos.interim"; contextId: string; timestampMs: number; text: string } {
  return { kind: "eos.interim", contextId, timestampMs: Date.now(), text };
}

function ttsText(contextId: string, text: string): TextToSpeechTextPacket {
  return { kind: "tts.text", contextId, timestampMs: Date.now(), text };
}

function wordTimestamps(contextId: string, words: TtsWordTimestamp[]): TextToSpeechWordTimestampsPacket {
  return { kind: "tts.word_timestamps", contextId, timestampMs: Date.now(), words };
}

function playoutProgress(contextId: string, playedOutMs: number): TextToSpeechPlayoutProgressPacket {
  return { kind: "tts.playout_progress", contextId, timestampMs: Date.now(), playedOutMs, complete: false };
}

function interruptLlm(contextId: string): InterruptLlmPacket {
  return { kind: "interrupt.llm", contextId, timestampMs: Date.now() };
}

function textDelta(text: string): TextStreamPart<ToolSet> {
  return { type: "text-delta", id: "0", text, providerMetadata: undefined } as TextStreamPart<ToolSet>;
}

function finish(finishReason: FinishReason): TextStreamPart<ToolSet> {
  return {
    type: "finish",
    finishReason,
    totalUsage: ZERO_USAGE,
    usage: ZERO_USAGE,
    providerMetadata: undefined,
    response: {},
  } as unknown as TextStreamPart<ToolSet>;
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

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 2000) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}