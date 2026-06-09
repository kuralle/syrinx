// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import type { Reasoner, ReasonerTurn, ReasoningPart } from "@kuralle-syrinx/core";
import {
  fromKuralleRuntime,
  type KuralleRuntimeLike,
  type KuralleStreamPart,
} from "./from-kuralle.js";

function baseTurn(): ReasonerTurn {
  return {
    userText: "Hi",
    messages: [{ role: "system", content: "test" }],
    signal: new AbortController().signal,
  };
}

function textDelta(delta: string): KuralleStreamPart {
  return { type: "text-delta", delta };
}

function toolCall(toolCallId: string, toolName: string, args: Record<string, unknown>): KuralleStreamPart {
  return { type: "tool-call", toolCallId, toolName, args };
}

function toolResult(toolCallId: string, toolName: string, result: unknown): KuralleStreamPart {
  return { type: "tool-result", toolCallId, toolName, result };
}

function errorPart(error: string): KuralleStreamPart {
  return { type: "error", error };
}

function done(sessionId?: string): KuralleStreamPart {
  return { type: "done", sessionId };
}

async function* partsToEvents(parts: KuralleStreamPart[]): AsyncIterable<KuralleStreamPart> {
  for (const p of parts) yield p;
}

function fakeRuntime(
  parts: KuralleStreamPart[],
  spy?: {
    runOpts?: {
      input?: string;
      sessionId?: string;
      userId?: string;
      agentId?: string;
      abortSignal?: AbortSignal;
    };
  },
): KuralleRuntimeLike {
  return {
    run(opts) {
      if (spy) spy.runOpts = opts;
      return { events: partsToEvents(parts) };
    },
  };
}

async function collectParts(reasoner: Reasoner, turn: ReasonerTurn): Promise<ReasoningPart[]> {
  const collected: ReasoningPart[] = [];
  for await (const part of reasoner.stream(turn)) {
    collected.push(part);
  }
  return collected;
}

describe("fromKuralleRuntime", () => {
  it("maps happy path: text deltas and done to finish:stop", async () => {
    const reasoner = fromKuralleRuntime(
      fakeRuntime([textDelta("Hi"), textDelta(" there"), done("sess-1")]),
      { sessionId: "sess-1" },
    );

    const parts = await collectParts(reasoner, baseTurn());

    expect(parts).toEqual([
      { type: "text-delta", text: "Hi" },
      { type: "text-delta", text: " there" },
      { type: "finish", reason: "stop", text: "Hi there" },
    ]);
  });

  it("maps tool-call and tool-result with toolId from toolCallId", async () => {
    const reasoner = fromKuralleRuntime(
      fakeRuntime([
        toolCall("tc-1", "lookup", { id: "123" }),
        toolResult("tc-1", "lookup", { found: true }),
        done(),
      ]),
      { sessionId: "sess-1" },
    );

    const parts = await collectParts(reasoner, baseTurn());

    expect(parts).toEqual([
      {
        type: "tool-call",
        toolId: "tc-1",
        toolName: "lookup",
        args: { id: "123" },
      },
      {
        type: "tool-result",
        toolId: "tc-1",
        toolName: "lookup",
        result: JSON.stringify({ found: true }),
      },
      { type: "finish", reason: "stop", text: "" },
    ]);
  });

  it("maps error part to terminal error", async () => {
    const reasoner = fromKuralleRuntime(fakeRuntime([errorPart("boom")]), { sessionId: "sess-1" });

    const parts = await collectParts(reasoner, baseTurn());

    expect(parts).toHaveLength(1);
    expect(parts[0]?.type).toBe("error");
    if (parts[0]?.type === "error") {
      expect(parts[0].cause.message).toBe("boom");
      expect(parts[0].recoverable).toBe(false);
    }
  });

  it("yields terminal error when stream ends without done", async () => {
    const reasoner = fromKuralleRuntime(fakeRuntime([textDelta("partial")]), { sessionId: "sess-1" });

    const parts = await collectParts(reasoner, baseTurn());

    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: "text-delta", text: "partial" });
    expect(parts[1]?.type).toBe("error");
    if (parts[1]?.type === "error") {
      expect(parts[1].cause.message).toBe("Kuralle stream ended without a done part");
      expect(parts[1].recoverable).toBe(false);
    }
  });

  it("returns without yielding when turn.signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const turn: ReasonerTurn = { ...baseTurn(), signal: controller.signal };

    const reasoner = fromKuralleRuntime(
      fakeRuntime([textDelta("should not appear"), done()]),
      { sessionId: "sess-1" },
    );

    const parts = await collectParts(reasoner, turn);

    expect(parts).toEqual([]);
  });

  it("passes only userText to run, not turn.messages", async () => {
    const spy: { runOpts?: { input?: string; sessionId?: string } } = {};
    const reasoner = fromKuralleRuntime(fakeRuntime([done()], spy), { sessionId: "sess-42" });

    const turn: ReasonerTurn = {
      userText: "What is my name?",
      messages: [
        { role: "system", content: "ignored" },
        { role: "user", content: "also ignored" },
      ],
      signal: new AbortController().signal,
    };
    await collectParts(reasoner, turn);

    expect(spy.runOpts?.input).toBe("What is my name?");
    expect(spy.runOpts?.sessionId).toBe("sess-42");
  });
});
