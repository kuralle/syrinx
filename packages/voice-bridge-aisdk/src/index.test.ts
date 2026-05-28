// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { PipelineBusImpl, Route } from "@asyncdot/voice";
import type { EndOfSpeechPacket, LlmErrorPacket, LlmResponseDonePacket } from "@asyncdot/voice";
import type { FinishReason, TextStreamPart, ToolSet } from "ai";
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
});

function baseConfig(): Record<string, unknown> {
  return {
    api_key: "test-key",
    model: "gemini-test",
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
