// SPDX-License-Identifier: MIT
import type { Reasoner, ReasonerTurn, ReasonerMessage, ReasoningPart } from "@asyncdot/voice";
import { categorizeLlmError, isRecoverable } from "@asyncdot/voice";

type MastraStreamOutput = { readonly runId: string; readonly fullStream: ReadableStream<MastraChunk> };

export interface MastraAgentLike {
  stream(
    messages: MastraMessage[],
    options?: { abortSignal?: AbortSignal },
  ): Promise<MastraStreamOutput>;
  resumeStream(
    resumeData: unknown,
    options: { runId: string; toolCallId?: string; abortSignal?: AbortSignal },
  ): Promise<MastraStreamOutput>;
}

export interface MastraChunk {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

type MastraMessage = { role: "system" | "user" | "assistant" | "tool"; content: string };

export function fromMastraAgent(agent: MastraAgentLike): Reasoner {
  return { stream: (turn) => streamFromMastra(agent, turn) };
}

function buildMessages(turn: ReasonerTurn): MastraMessage[] {
  return [
    ...turn.messages.map((m: ReasonerMessage) => ({ role: m.role, content: m.content })),
    { role: "user", content: turn.userText },
  ];
}

async function* streamFromMastra(
  agent: MastraAgentLike,
  turn: ReasonerTurn,
): AsyncGenerator<ReasoningPart> {
  const out = turn.resume
    ? await agent.resumeStream(turn.resume.data, {
        runId: turn.resume.runId,
        abortSignal: turn.signal,
      })
    : await agent.stream(buildMessages(turn), { abortSignal: turn.signal });
  let acc = "";
  for await (const chunk of out.fullStream) {
    if (turn.signal.aborted) return;
    switch (chunk.type) {
      case "text-delta": {
        const t = String(chunk.payload.text ?? "");
        acc += t;
        yield { type: "text-delta", text: t };
        break;
      }
      case "tool-call":
        yield {
          type: "tool-call",
          toolId: String(chunk.payload.toolCallId ?? ""),
          toolName: String(chunk.payload.toolName ?? ""),
          args: toRecord(chunk.payload.args),
        };
        break;
      case "tool-result":
        yield {
          type: "tool-result",
          toolId: String(chunk.payload.toolCallId ?? ""),
          toolName: String(chunk.payload.toolName ?? ""),
          result: stringifyResult(chunk.payload.result),
        };
        break;
      case "error":
        yield toErrorPart(chunk.payload.error);
        return;
      case "finish": {
        const reason = chunk.payload.stepResult as { reason?: string } | undefined;
        const finishReason = reason?.reason;
        if (finishReason === "stop" || finishReason === "tool-calls" || finishReason === "length") {
          yield {
            type: "finish",
            reason: finishReason === "tool-calls" ? "tool" : finishReason,
            text: acc,
          };
          return;
        }
        yield toErrorPart(
          new Error(`Mastra provider did not complete normally: ${String(finishReason)}`),
        );
        return;
      }
      case "tool-call-suspended": {
        const sp = chunk.payload.suspendPayload as Record<string, unknown> | undefined;
        const prompt =
          typeof sp?.["message"] === "string"
            ? (sp["message"] as string)
            : typeof sp?.["prompt"] === "string"
              ? (sp["prompt"] as string)
              : undefined;
        yield {
          type: "suspended",
          runId: out.runId,
          prompt,
          payload: chunk.payload.suspendPayload,
        };
        return;
      }
      default:
        break;
    }
  }
  yield toErrorPart(new Error("Mastra stream ended without a finish chunk"));
}

function toErrorPart(error: unknown): ReasoningPart {
  const cause = error instanceof Error ? error : new Error(String(error));
  return { type: "error", cause, recoverable: isRecoverable(categorizeLlmError(cause)) };
}

function stringifyResult(r: unknown): string {
  return typeof r === "string" ? r : JSON.stringify(r);
}

function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
