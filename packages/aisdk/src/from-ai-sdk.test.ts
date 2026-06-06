// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import type { FinishReason, TextStreamPart, ToolSet } from "ai";
import type { Reasoner, ReasonerTurn, ReasoningPart } from "@kuralle-syrinx/core";
import { fromAiSdkAgent, fromStreamFactory, type AiSdkAgentLike } from "./from-ai-sdk.js";

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

function baseTurn(): ReasonerTurn {
  return {
    userText: "Hi",
    messages: [{ role: "system", content: "test" }],
    signal: new AbortController().signal,
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

function finishStep(finishReason: FinishReason, rawFinishReason?: string): TextStreamPart<ToolSet> {
  return {
    type: "finish-step",
    finishReason,
    rawFinishReason,
    usage: ZERO_USAGE,
    providerMetadata: undefined,
    response: {},
  } as TextStreamPart<ToolSet>;
}

function toolCall(toolCallId: string, toolName: string, input: Record<string, unknown>): TextStreamPart<ToolSet> {
  return {
    type: "tool-call",
    toolCallId,
    toolName,
    input,
  } as TextStreamPart<ToolSet>;
}

function toolResult(
  toolCallId: string,
  toolName: string,
  output: unknown,
): TextStreamPart<ToolSet> {
  return {
    type: "tool-result",
    toolCallId,
    toolName,
    input: {},
    output,
  } as TextStreamPart<ToolSet>;
}

function errorPart(error: unknown): TextStreamPart<ToolSet> {
  return { type: "error", error } as TextStreamPart<ToolSet>;
}

function toolErrorPart(toolCallId: string, toolName: string, error: unknown): TextStreamPart<ToolSet> {
  return {
    type: "tool-error",
    toolCallId,
    toolName,
    input: {},
    error,
  } as TextStreamPart<ToolSet>;
}

async function collectParts(reasoner: Reasoner, turn: ReasonerTurn): Promise<ReasoningPart[]> {
  const parts: ReasoningPart[] = [];
  for await (const part of reasoner.stream(turn)) {
    parts.push(part);
  }
  return parts;
}

describe("from-ai-sdk adapters", () => {
  it("maps happy path: deltas, tool-call, tool-result, finish:stop", async () => {
    const reasoner = fromStreamFactory(async function* () {
      yield textDelta("Hello ");
      yield textDelta("world.");
      yield toolCall("tc-1", "get_weather", { city: "NYC" });
      yield toolResult("tc-1", "get_weather", { temp: 72 });
      yield finish("stop");
    });

    const parts = await collectParts(reasoner, baseTurn());

    expect(parts).toEqual([
      { type: "text-delta", text: "Hello " },
      { type: "text-delta", text: "world." },
      {
        type: "tool-call",
        toolId: "tc-1",
        toolName: "get_weather",
        args: { city: "NYC" },
      },
      {
        type: "tool-result",
        toolId: "tc-1",
        toolName: "get_weather",
        result: JSON.stringify({ temp: 72 }),
      },
      { type: "finish", reason: "stop", text: "Hello world." },
    ]);
  });

  it("maps error part to terminal error", async () => {
    const reasoner = fromStreamFactory(async function* () {
      yield textDelta("partial");
      yield errorPart(new Error("provider failed"));
    });

    const parts = await collectParts(reasoner, baseTurn());

    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: "text-delta", text: "partial" });
    expect(parts[1]?.type).toBe("error");
    if (parts[1]?.type === "error") {
      expect(parts[1].cause.message).toBe("provider failed");
      expect(parts[1].recoverable).toBe(false);
    }
  });

  it("maps tool-error part to terminal error", async () => {
    const reasoner = fromStreamFactory(async function* () {
      yield toolErrorPart("tc-1", "broken_tool", new Error("tool exploded"));
    });

    const parts = await collectParts(reasoner, baseTurn());

    expect(parts).toHaveLength(1);
    expect(parts[0]?.type).toBe("error");
    if (parts[0]?.type === "error") {
      expect(parts[0].cause.message).toBe("tool exploded");
    }
  });

  it("maps finish-step(error) to terminal error", async () => {
    const reasoner = fromStreamFactory(async function* () {
      yield finishStep("error", "MALFORMED_FUNCTION_CALL");
    });

    const parts = await collectParts(reasoner, baseTurn());

    expect(parts).toHaveLength(1);
    expect(parts[0]?.type).toBe("error");
    if (parts[0]?.type === "error") {
      expect(parts[0].cause.message).toBe(
        "AI SDK provider step failed: error (MALFORMED_FUNCTION_CALL)",
      );
      expect(parts[0].recoverable).toBe(true);
    }
  });

  it("maps finish(length) to finish with accumulated text", async () => {
    const reasoner = fromStreamFactory(async function* () {
      yield textDelta("truncated");
      yield finish("length", "MAX_TOKENS");
    });

    const parts = await collectParts(reasoner, baseTurn());

    expect(parts).toEqual([
      { type: "text-delta", text: "truncated" },
      { type: "finish", reason: "length", text: "truncated" },
    ]);
  });

  it("drops reasoning-delta and tool-input-start parts", async () => {
    const reasoner = fromStreamFactory(async function* () {
      yield {
        type: "reasoning-delta",
        id: "r1",
        text: "thinking...",
        providerMetadata: undefined,
      } as TextStreamPart<ToolSet>;
      yield {
        type: "tool-input-start",
        id: "t1",
        toolName: "search",
        providerMetadata: undefined,
      } as TextStreamPart<ToolSet>;
      yield textDelta("answer");
      yield finish("stop");
    });

    const parts = await collectParts(reasoner, baseTurn());

    expect(parts).toEqual([
      { type: "text-delta", text: "answer" },
      { type: "finish", reason: "stop", text: "answer" },
    ]);
  });

  it("yields first text-delta before source stream completes (no buffering)", async () => {
    let resolveGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });

    const reasoner = fromStreamFactory(async function* () {
      yield textDelta("immediate");
      await gate;
    });

    const iterator = reasoner.stream(baseTurn())[Symbol.asyncIterator]();
    const first = await iterator.next();

    expect(first.done).toBe(false);
    expect(first.value).toEqual({ type: "text-delta", text: "immediate" });
    resolveGate?.();
  });

  it("maps stream ending without finish to terminal error", async () => {
    const reasoner = fromStreamFactory(async function* () {
      yield textDelta("no finish");
    });

    const parts = await collectParts(reasoner, baseTurn());

    expect(parts).toHaveLength(2);
    expect(parts[1]?.type).toBe("error");
    if (parts[1]?.type === "error") {
      expect(parts[1].cause.message).toBe("AI SDK stream ended without a provider finish reason");
    }
  });

  it("fromAiSdkAgent maps agent fullStream through the same table", async () => {
    const agent: AiSdkAgentLike = {
      async stream() {
        return {
          fullStream: (async function* () {
            yield textDelta("From ");
            yield textDelta("agent");
            yield finish("stop");
          })(),
        };
      },
    };

    const parts = await collectParts(fromAiSdkAgent(agent), baseTurn());

    expect(parts).toEqual([
      { type: "text-delta", text: "From " },
      { type: "text-delta", text: "agent" },
      { type: "finish", reason: "stop", text: "From agent" },
    ]);
  });
});
