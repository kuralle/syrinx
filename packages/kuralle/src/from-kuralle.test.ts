// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import type { Reasoner, ReasonerTurn, ReasoningPart } from "@kuralle-syrinx/core";
import {
  buildKuralleTurnRunOptions,
  fromKuralleRuntime,
  reconcileSpokenPrefix,
  rewriteLastAssistant,
  type KuralleMessageLike,
  type KuralleRunOptions,
  type KuralleRuntimeLike,
  type KuralleSessionStoreLike,
  type KuralleStoredSession,
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

describe("fromKuralleRuntime G4 resume-by-seed (historyDelta)", () => {
  const turnWithContext = (): ReasonerTurn => ({
    userText: "Second question",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
    ],
    signal: new AbortController().signal,
  });

  it("seeds prior turn.messages into an EMPTY kuralle session (fresh isolate resume)", async () => {
    const spy: { runOpts?: KuralleRunOptions } = {};
    const runtime: KuralleRuntimeLike = {
      run(opts) {
        spy.runOpts = opts;
        return { events: partsToEvents([textDelta("ok"), done()]) };
      },
      getSession: async () => null,
    };
    const reasoner = fromKuralleRuntime(runtime, { sessionId: "sess-1" });

    await collectParts(reasoner, turnWithContext());

    expect(spy.runOpts?.input).toBe("Second question");
    expect(spy.runOpts?.historyDelta).toEqual([
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
    ]);
  });

  it("does NOT seed into a non-empty session (no double-applied history, R6)", async () => {
    const spy: { runOpts?: KuralleRunOptions } = {};
    const runtime: KuralleRuntimeLike = {
      run(opts) {
        spy.runOpts = opts;
        return { events: partsToEvents([textDelta("ok"), done()]) };
      },
      getSession: async () => ({
        id: "sess-1",
        messages: [{ role: "user", content: "already there" }],
      }),
    };
    const reasoner = fromKuralleRuntime(runtime, { sessionId: "sess-1" });

    await collectParts(reasoner, turnWithContext());

    expect(spy.runOpts?.input).toBe("Second question");
    expect(spy.runOpts?.historyDelta).toBeUndefined();
  });
});

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

  it("flow resume pre-appends user message and omits input", async () => {
    const sessionId = "sess-flow";
    const store = createMockSessionStore(sessionId, [{ role: "assistant", content: "What is your name?" }]);
    const session = (await store.get(sessionId))!;
    session.durableRuns = {
      [sessionId]: {
        runState: {
          activeFlow: "book-advisor-appointment",
          messages: [{ role: "assistant", content: "What is your name?" }],
        },
        steps: [],
      },
    };
    await store.save(session);

    const runtime: KuralleRuntimeLike = {
      run: () => ({ events: partsToEvents([done()]) }),
      getSession: (id) => store.get(id),
      getSessionStore: () => store,
    };

    const opts = await buildKuralleTurnRunOptions(runtime, {
      sessionId,
      userText: "Priya, CS masters, Friday",
    });

    expect(opts.input).toBeUndefined();
    expect(opts.historyDelta).toBeUndefined();
    const saved = await store.get(sessionId);
    expect(saved?.messages.at(-1)).toEqual({ role: "user", content: "Priya, CS masters, Friday" });
    const runMessages = (
      saved?.durableRuns as Record<string, { runState: { messages: KuralleMessageLike[] } }>
    )[sessionId]?.runState.messages;
    expect(runMessages?.at(-1)).toEqual({ role: "user", content: "Priya, CS masters, Friday" });
  });

  it("rewriteLastAssistant truncates only when spoken prefix is shorter", () => {
    const messages: KuralleMessageLike[] = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello there friend" },
    ];
    expect(rewriteLastAssistant(messages, "Hello")).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
    ]);
    expect(rewriteLastAssistant(messages, "Hello there friend")).toStrictEqual(messages);
  });

  it("after barge-in abort, reconciles persisted assistant message to spoken prefix", async () => {
    const fullText = "Hello there friend";
    const spokenPrefix = "Hello";
    const sessionId = "sess-barge";
    const store = createMockSessionStore(sessionId, []);

    await reconcileSpokenPrefix(
      { run: () => ({ events: partsToEvents([]) }), getSessionStore: () => store },
      sessionId,
      spokenPrefix,
    );
    let session = await store.get(sessionId);
    expect(session?.messages).toEqual([]);

    session = (await store.get(sessionId)) ?? { id: sessionId, messages: [] };
    session.messages = [{ role: "assistant", content: fullText }];
    await store.save(session);

    await reconcileSpokenPrefix(
      { run: () => ({ events: partsToEvents([]) }), getSessionStore: () => store },
      sessionId,
      spokenPrefix,
    );
    session = await store.get(sessionId);
    expect(session?.messages.at(-1)).toEqual({ role: "assistant", content: spokenPrefix });
  });

  it("reconcileSpokenPrefix rewrites durable run messages", async () => {
    const sessionId = "sess-durable";
    const store = createMockSessionStore(sessionId, []);
    const session = (await store.get(sessionId))!;
    session.messages = [{ role: "assistant", content: "full reply text" }];
    session.durableRuns = {
      [sessionId]: {
        runState: { messages: [{ role: "assistant", content: "full reply text" }] },
        steps: [],
      },
    };
    await store.save(session);

    await reconcileSpokenPrefix(
      { run: () => ({ events: partsToEvents([]) }), getSessionStore: () => store },
      sessionId,
      "full",
    );

    const saved = await store.get(sessionId);
    expect(saved?.messages.at(-1)).toEqual({ role: "assistant", content: "full" });
    const runState = (saved?.durableRuns as Record<string, { runState: { messages: KuralleMessageLike[] } }>)[sessionId]
      ?.runState;
    expect(runState?.messages.at(-1)).toEqual({ role: "assistant", content: "full" });
  });
});

function createMockSessionStore(sessionId: string, messages: KuralleMessageLike[]): KuralleSessionStoreLike {
  const sessions = new Map<string, KuralleStoredSession>([
    [sessionId, { id: sessionId, messages: [...messages] }],
  ]);
  return {
    async get(id) {
      const session = sessions.get(id);
      return session ? structuredClone(session) : null;
    },
    async save(session) {
      sessions.set(session.id, structuredClone(session));
    },
  };
}
