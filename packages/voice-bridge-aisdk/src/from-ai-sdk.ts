// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — AI SDK → Reasoner adapters
//
// Normalizes ai@6 TextStreamPart streams into the Reasoner/ReasoningPart seam.
// See RFC §4.3 and Sprint 0 PLAN §6.

import {
  streamText,
  type FinishReason,
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
  type ReasonerTurn,
  type ReasoningPart,
} from "@asyncdot/voice";
import type { AISDKStreamFactory } from "./index.js";

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
};

export function fromAiSdkAgent(agent: AiSdkAgentLike): Reasoner {
  return {
    stream(turn: ReasonerTurn): AsyncIterable<ReasoningPart> {
      return streamFromAgent(agent, turn);
    },
  };
}

export function fromStreamText(config: StreamTextConfig): Reasoner {
  return {
    stream(turn: ReasonerTurn): AsyncIterable<ReasoningPart> {
      return streamFromStreamText(config, turn);
    },
  };
}

export function fromStreamFactory(factory: AISDKStreamFactory): Reasoner {
  return {
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

async function* streamFromStreamText(config: StreamTextConfig, turn: ReasonerTurn): AsyncGenerator<ReasoningPart> {
  const messages = buildMessagesForTurn(turn);
  const result = streamText({
    ...config,
    messages,
    abortSignal: turn.signal,
  });
  yield* mapTextStreamParts(result.fullStream);
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
        const cause = new Error(part.reason ?? "AI SDK stream aborted");
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
