// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FinishReason, TextStreamPart, ToolSet } from "ai";

const streamTextCalls: Array<Record<string, unknown>> = [];

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    streamText: (opts: Record<string, unknown>) => {
      streamTextCalls.push(opts);
      return {
        fullStream: (async function* (): AsyncGenerator<TextStreamPart<ToolSet>> {
          yield {
            type: "finish",
            finishReason: "stop" as FinishReason,
            rawFinishReason: undefined,
            totalUsage: {
              inputTokens: 0,
              inputTokenDetails: {
                noCacheTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
              },
              outputTokens: 0,
              outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
              totalTokens: 0,
            },
            usage: {
              inputTokens: 0,
              inputTokenDetails: {
                noCacheTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
              },
              outputTokens: 0,
              outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
              totalTokens: 0,
            },
            providerMetadata: undefined,
            response: {},
          } as TextStreamPart<ToolSet>;
        })(),
      };
    },
  };
});

import { fromStreamText } from "./from-ai-sdk.js";

describe("fromStreamText prewarm affinity", () => {
  beforeEach(() => {
    streamTextCalls.length = 0;
  });

  it("sets promptCacheKey on prewarm and subsequent stream calls", async () => {
    const reasoner = fromStreamText({ model: "openai/gpt-4.1-mini" as never });
    await reasoner.prewarm?.({ sessionId: "affinity-session" });

    const controller = new AbortController();
    for await (const _part of reasoner.stream({
      userText: "Hi",
      messages: [{ role: "system", content: "test" }],
      signal: controller.signal,
    })) {
      break;
    }

    expect(streamTextCalls).toHaveLength(2);
    expect(streamTextCalls[0]?.["providerOptions"]).toEqual({
      openai: { promptCacheKey: "affinity-session" },
    });
    expect(streamTextCalls[1]?.["providerOptions"]).toEqual({
      openai: { promptCacheKey: "affinity-session" },
    });
  });
});
