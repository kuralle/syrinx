// SPDX-License-Identifier: MIT

import type { Reasoner, ReasonerTurn, ReasoningPart } from "@kuralle-syrinx/core";
import { categorizeLlmError, isRecoverable } from "@kuralle-syrinx/core";

export interface KuralleStreamPart {
  readonly type: string;
  readonly delta?: string;
  readonly toolName?: string;
  readonly args?: unknown;
  readonly toolCallId?: string;
  readonly result?: unknown;
  readonly error?: string;
  readonly waitingFor?: string;
  readonly nodeId?: string;
  readonly options?: unknown;
  readonly prompt?: string;
  readonly sessionId?: string;
}

export interface KuralleRuntimeLike {
  run(opts: {
    readonly input?: string;
    readonly sessionId?: string;
    readonly userId?: string;
    readonly agentId?: string;
    readonly abortSignal?: AbortSignal;
  }): { readonly events: AsyncIterable<KuralleStreamPart> };
}

export interface FromKuralleRuntimeOptions {
  readonly sessionId: string;
  readonly userId?: string;
  readonly agentId?: string;
}

export function fromKuralleRuntime(runtime: KuralleRuntimeLike, opts: FromKuralleRuntimeOptions): Reasoner {
  return { stream: (turn) => streamFromKuralle(runtime, turn, opts) };
}

export async function* streamFromKuralle(
  runtime: KuralleRuntimeLike,
  turn: ReasonerTurn,
  opts: FromKuralleRuntimeOptions,
): AsyncGenerator<ReasoningPart> {
  const handle = runtime.run({
    input: turn.userText,
    sessionId: opts.sessionId,
    userId: opts.userId,
    agentId: opts.agentId,
    abortSignal: turn.signal,
  });

  let acc = "";
  for await (const part of handle.events) {
    if (turn.signal.aborted) return;
    switch (part.type) {
      case "text-delta": {
        const t = String(part.delta ?? "");
        acc += t;
        yield { type: "text-delta", text: t };
        break;
      }
      case "tool-call":
        yield {
          type: "tool-call",
          toolId: String(part.toolCallId ?? ""),
          toolName: String(part.toolName ?? ""),
          args: toRecord(part.args),
        };
        break;
      case "tool-result":
        yield {
          type: "tool-result",
          toolId: String(part.toolCallId ?? ""),
          toolName: String(part.toolName ?? ""),
          result: stringifyResult(part.result),
        };
        break;
      case "error":
        yield toErrorPart(new Error(String(part.error ?? "Kuralle error")));
        return;
      case "paused":
        yield {
          type: "suspended",
          runId: opts.sessionId,
          prompt: typeof part.waitingFor === "string" ? part.waitingFor : undefined,
          payload: part,
        };
        return;
      case "interactive":
        yield {
          type: "suspended",
          runId: opts.sessionId,
          prompt: typeof part.prompt === "string" ? part.prompt : undefined,
          payload: part,
        };
        return;
      case "done":
        yield { type: "finish", reason: "stop", text: acc };
        return;
      default:
        break;
    }
  }
  yield toErrorPart(new Error("Kuralle stream ended without a done part"));
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
