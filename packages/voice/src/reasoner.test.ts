// SPDX-License-Identifier: MIT
//
// Compile-guard: pins the ReasoningPart union shape without runtime consumers.

import { describe, expect, it } from "vitest";

import type { Reasoner, ReasonerMessage, ReasonerTurn, ReasoningPart } from "./reasoner.js";

describe("Reasoner seam types", () => {
  it("reasoner_union_compile_guard", async () => {
    const userMsg = { role: "user", content: "hi" } satisfies ReasonerMessage;

    const turn: ReasonerTurn = {
      userText: "hi",
      messages: [userMsg],
      signal: new AbortController().signal,
    };

    const textDeltaPart = { type: "text-delta", text: "hello" } satisfies ReasoningPart;
    const toolCallPart = {
      type: "tool-call",
      toolId: "tool-1",
      toolName: "doThing",
      args: { input: 123 },
    } satisfies ReasoningPart;
    const toolResultPart = {
      type: "tool-result",
      toolId: "tool-1",
      toolName: "doThing",
      result: "ok",
    } satisfies ReasoningPart;
    const suspendedPart = {
      type: "suspended",
      runId: "run-1",
      toolId: "tool-1",
      prompt: "Pause for human-in-the-loop.",
      payload: { step: 3 },
    } satisfies ReasoningPart;
    const errorPart = {
      type: "error",
      cause: new Error("backend exploded"),
      recoverable: true,
    } satisfies ReasoningPart;
    const finishPart = { type: "finish", reason: "stop", text: "done" } satisfies ReasoningPart;

    const emptyStream = async function*(): AsyncIterable<ReasoningPart> {
      // Intentionally empty: this is purely a type-level compile guard.
    };

    const reasoner: Reasoner = {
      stream: (_turn: ReasonerTurn): AsyncIterable<ReasoningPart> => emptyStream(),
    };

    const collected: ReasoningPart[] = [];
    for await (const part of reasoner.stream(turn)) {
      collected.push(part);
    }

    expect(collected).toEqual([]);
    expect(textDeltaPart).toBeDefined();
    expect(toolCallPart).toBeDefined();
    expect(toolResultPart).toBeDefined();
    expect(suspendedPart).toBeDefined();
    expect(errorPart).toBeDefined();
    expect(finishPart).toBeDefined();
    expect(reasoner).toBeDefined();
  });
});

