// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — AI SDK → Reasoner adapters
//
// Normalizes ai@6 TextStreamPart streams into the Reasoner/ReasoningPart seam.
// See RFC §4.3 and Sprint 0 PLAN §6.

import {
  streamText,
  type FinishReason,
  type LanguageModelUsage,
  type ModelMessage,
  type TextStreamPart,
  type ToolChoice,
  type ToolSet,
} from "ai";
import {
  categorizeLlmError,
  isRecoverable,
  type Reasoner,
  type ReasonerMessage,
  type ReasonerPrewarmContext,
  type ReasonerTurn,
  type ReasonerUsage,
  type ReasoningPart,
} from "@kuralle-syrinx/core";
import type { AISDKStreamFactory } from "./index.js";

/** Internal probe text — warms the backend without surfacing voice output. */
const PREWARM_PROBE = "\u200b";

interface AffinityState {
  promptCacheKey: string | undefined;
}

function createAffinityState(): AffinityState {
  return { promptCacheKey: undefined };
}

function providerOptionsForAffinity(
  key: string | undefined,
  base?: Parameters<typeof streamText>[0]["providerOptions"],
): Parameters<typeof streamText>[0]["providerOptions"] {
  if (!key) return base;
  const openai = {
    ...((base as { openai?: Record<string, unknown> } | undefined)?.openai ?? {}),
    promptCacheKey: key,
  };
  return { ...(base ?? {}), openai } as Parameters<typeof streamText>[0]["providerOptions"];
}

async function drainPrewarmStream(source: AsyncIterable<TextStreamPart<ToolSet>>): Promise<void> {
  for await (const part of source) {
    if (part.type === "finish" || part.type === "error" || part.type === "abort") return;
  }
}

function prewarmMessages(ctx: ReasonerPrewarmContext): ModelMessage[] {
  return [...mapMessages(ctx.seedMessages ?? []), { role: "user", content: PREWARM_PROBE }];
}

export interface AiSdkAgentLike {
  stream(opts: {
    messages: ModelMessage[];
    abortSignal: AbortSignal;
  }): Promise<{ fullStream: AsyncIterable<TextStreamPart<ToolSet>> }>;
}

export type StreamTextConfig = {
  model: Parameters<typeof streamText>[0]["model"];
  system?: string;
  tools?: ToolSet;
  toolChoice?: ToolChoice<ToolSet>;
  temperature?: number;
  maxOutputTokens?: number;
  maxRetries?: number;
  timeout?: number;
  stopWhen?: Parameters<typeof streamText>[0]["stopWhen"];
  providerOptions?: Parameters<typeof streamText>[0]["providerOptions"];
};

export function fromAiSdkAgent(agent: AiSdkAgentLike): Reasoner {
  const affinity = createAffinityState();
  return {
    async prewarm(ctx: ReasonerPrewarmContext): Promise<void> {
      affinity.promptCacheKey = ctx.sessionId;
      const messages = prewarmMessages(ctx);
      const result = await agent.stream({ messages, abortSignal: AbortSignal.timeout(30_000) });
      await drainPrewarmStream(result.fullStream);
    },
    stream(turn: ReasonerTurn): AsyncIterable<ReasoningPart> {
      return streamFromAgent(agent, turn);
    },
  };
}

export function fromStreamText(config: StreamTextConfig): Reasoner {
  const affinity = createAffinityState();
  return {
    async prewarm(ctx: ReasonerPrewarmContext): Promise<void> {
      affinity.promptCacheKey = ctx.sessionId;
      const result = streamText({
        ...config,
        system: ctx.systemPrompt ?? config.system,
        messages: prewarmMessages(ctx),
        maxOutputTokens: 1,
        providerOptions: providerOptionsForAffinity(ctx.sessionId, config.providerOptions),
      });
      await drainPrewarmStream(result.fullStream);
    },
    stream(turn: ReasonerTurn): AsyncIterable<ReasoningPart> {
      return streamFromStreamText(config, turn, affinity);
    },
  };
}

export function fromStreamFactory(factory: AISDKStreamFactory): Reasoner {
  const affinity = createAffinityState();
  return {
    async prewarm(ctx: ReasonerPrewarmContext): Promise<void> {
      affinity.promptCacheKey = ctx.sessionId;
      const messages = prewarmMessages(ctx);
      await drainPrewarmStream(
        factory({ userText: PREWARM_PROBE, signal: AbortSignal.timeout(30_000), messages }),
      );
    },
    stream(turn: ReasonerTurn): AsyncIterable<ReasoningPart> {
      return streamFromFactory(factory, turn);
    },
  };
}

async function* streamFromAgent(agent: AiSdkAgentLike, turn: ReasonerTurn): AsyncGenerator<ReasoningPart> {
  const messages = buildMessagesForTurn(turn);
  const result = await agent.stream({ messages, abortSignal: turn.signal });
  yield* mapTextStreamParts(result.fullStream);
}

async function* streamFromStreamText(
  config: StreamTextConfig,
  turn: ReasonerTurn,
  affinity: AffinityState,
): AsyncGenerator<ReasoningPart> {
  const messages = buildMessagesForTurn(turn);
  const result = streamText({
    ...config,
    messages,
    abortSignal: turn.signal,
    providerOptions: providerOptionsForAffinity(affinity.promptCacheKey, config.providerOptions),
  });
  yield* mapTextStreamParts(result.fullStream, modelIdentity(config.model));
}

async function* streamFromFactory(factory: AISDKStreamFactory, turn: ReasonerTurn): AsyncGenerator<ReasoningPart> {
  const messages = buildMessagesForTurn(turn);
  yield* mapTextStreamParts(factory({ userText: turn.userText, signal: turn.signal, messages }));
}

function buildMessagesForTurn(turn: ReasonerTurn): ModelMessage[] {
  return [...mapMessages(turn.messages), { role: "user", content: turn.userText }];
}

function mapMessages(messages: readonly ReasonerMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.toolCallId ?? "",
            toolName: "",
            output: { type: "text", value: message.content },
          },
        ],
      };
    }
    return { role: message.role, content: message.content };
  });
}

async function* mapTextStreamParts(
  source: AsyncIterable<TextStreamPart<ToolSet>>,
  identity: { provider?: string; model?: string } = {},
): AsyncGenerator<ReasoningPart> {
  let accumulatedText = "";
  let sawFinish = false;

  for await (const part of source) {
    switch (part.type) {
      case "text-delta":
        accumulatedText += part.text;
        yield { type: "text-delta", text: part.text };
        break;
      case "tool-call":
        yield {
          type: "tool-call",
          toolId: part.toolCallId,
          toolName: part.toolName,
          args: toRecord(part.input),
        };
        break;
      case "tool-result":
        yield {
          type: "tool-result",
          toolId: part.toolCallId,
          toolName: part.toolName,
          result: stringifyToolOutput(part.output),
        };
        break;
      case "error": {
        const cause = part.error instanceof Error ? part.error : new Error(String(part.error));
        yield toErrorPart(cause);
        return;
      }
      case "tool-error": {
        const cause =
          part.error instanceof Error ? part.error : new Error(`Tool ${part.toolName} failed`);
        yield toErrorPart(cause);
        return;
      }
      case "abort": {
        // An abort is a benign cancellation (barge-in aborted the reasoner), NOT an error.
        // Carry the web/Node standard `name === "AbortError"` so downstream `isAbortError`
        // guards (realtime-bridge runDelegate, ReasoningBridge) swallow it instead of
        // surfacing a fatal `bridge.error/internal_fault`.
        const cause = new Error(part.reason ?? "AI SDK stream aborted");
        cause.name = "AbortError";
        yield toErrorPart(cause);
        return;
      }
      case "finish-step":
        if (part.finishReason === "error" || part.finishReason === "content-filter") {
          yield toErrorPart(
            new Error(
              `AI SDK provider step failed: ${formatFinishReason(part.finishReason, part.rawFinishReason)}`,
            ),
          );
          return;
        }
        break;
      case "finish":
        sawFinish = true;
        if (part.finishReason === "stop" || part.finishReason === "tool-calls" || part.finishReason === "length") {
          yield {
            type: "finish",
            reason: mapFinishReason(part.finishReason),
            text: accumulatedText,
            // The AI SDK finish part carries totalUsage; forward it so the bridge can
            // record cost. Omit entirely when the provider reported nothing.
            ...(part.totalUsage
              ? { usage: { ...identity, ...toReasonerUsage(part.totalUsage) } }
              : {}),
          };
          return;
        }
        if (
          part.finishReason === "error" ||
          part.finishReason === "content-filter" ||
          part.finishReason === "other" ||
          part.finishReason === "unknown"
        ) {
          yield toErrorPart(
            new Error(
              `AI SDK provider did not complete normally: ${formatFinishReason(part.finishReason, part.rawFinishReason)}`,
            ),
          );
          return;
        }
        break;
      default:
        break;
    }
  }

  if (!sawFinish) {
    yield toErrorPart(new Error("AI SDK stream ended without a provider finish reason"));
  }
}

/**
 * Extract provider/model for cost attribution. The AI SDK model is either a bare id
 * string (`"openai/gpt-4.1-mini"`) or a model object exposing `.provider` / `.modelId`.
 * Without this, usage counters are tagged with empty provider/model and spend cannot be
 * attributed to a model — the whole point of the low-cardinality tags.
 */
export function modelIdentity(model: StreamTextConfig["model"]): { provider?: string; model?: string } {
  if (typeof model === "string") return { model };
  const m = model as { provider?: unknown; modelId?: unknown };
  return {
    ...(typeof m.provider === "string" ? { provider: m.provider } : {}),
    ...(typeof m.modelId === "string" ? { model: m.modelId } : {}),
  };
}

/** Copy only the token fields the SDK actually populated (all are `number | undefined`). */
function toReasonerUsage(u: LanguageModelUsage): ReasonerUsage {
  return {
    ...(u.inputTokens !== undefined ? { inputTokens: u.inputTokens } : {}),
    ...(u.outputTokens !== undefined ? { outputTokens: u.outputTokens } : {}),
    ...(u.totalTokens !== undefined ? { totalTokens: u.totalTokens } : {}),
    ...(u.cachedInputTokens !== undefined ? { cachedInputTokens: u.cachedInputTokens } : {}),
    ...(u.reasoningTokens !== undefined ? { reasoningTokens: u.reasoningTokens } : {}),
  };
}

function mapFinishReason(finishReason: FinishReason): "stop" | "tool" | "length" {
  if (finishReason === "tool-calls") return "tool";
  if (finishReason === "length") return "length";
  return "stop";
}

function toErrorPart(cause: Error): ReasoningPart {
  return {
    type: "error",
    cause,
    recoverable: isRecoverable(categorizeLlmError(cause)),
  };
}

function formatFinishReason(finishReason: FinishReason, rawFinishReason: string | undefined): string {
  return rawFinishReason ? `${finishReason} (${rawFinishReason})` : finishReason;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringifyToolOutput(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}
