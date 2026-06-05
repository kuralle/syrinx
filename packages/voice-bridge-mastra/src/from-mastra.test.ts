// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import type { Reasoner, ReasonerTurn, ReasoningPart } from "@asyncdot/voice";
import { fromMastraAgent, type MastraAgentLike, type MastraChunk } from "./from-mastra.js";

function baseTurn(): ReasonerTurn {
  return {
    userText: "Hi",
    messages: [{ role: "system", content: "test" }],
    signal: new AbortController().signal,
  };
}

function textDelta(text: string): MastraChunk {
  return { type: "text-delta", payload: { text } };
}

function toolCall(toolCallId: string, toolName: string, args: Record<string, unknown>): MastraChunk {
  return { type: "tool-call", payload: { toolCallId, toolName, args } };
}

function toolResult(toolCallId: string, toolName: string, result: unknown): MastraChunk {
  return { type: "tool-result", payload: { toolCallId, toolName, result } };
}

function errorChunk(error: unknown): MastraChunk {
  return { type: "error", payload: { error } };
}

function finish(reason: string): MastraChunk {
  return { type: "finish", payload: { stepResult: { reason } } };
}

function chunksToStream(chunks: MastraChunk[]): ReadableStream<MastraChunk> {
  return new ReadableStream({
    start(controller) {
      for (const ch of chunks) controller.enqueue(ch);
      controller.close();
    },
  });
}

function delayedStream(first: MastraChunk): { stream: ReadableStream<MastraChunk>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stream = new ReadableStream<MastraChunk>({
    async start(controller) {
      controller.enqueue(first);
      await gate;
      controller.close();
    },
  });
  return { stream, release };
}

function fakeAgent(
  chunks: MastraChunk[] | ReadableStream<MastraChunk>,
  opts?: {
    runId?: string;
    resume?: {
      chunks: MastraChunk[] | ReadableStream<MastraChunk>;
      runId?: string;
    };
    spy?: {
      streamCalled?: boolean;
      resumeCalled?: boolean;
      resumeData?: unknown;
      resumeOptions?: { runId: string; toolCallId?: string; abortSignal?: AbortSignal };
    };
  },
): MastraAgentLike {
  const spy = opts?.spy;
  return {
    async stream() {
      if (spy) spy.streamCalled = true;
      return {
        runId: opts?.runId ?? "r1",
        fullStream: chunks instanceof ReadableStream ? chunks : chunksToStream(chunks),
      };
    },
    async resumeStream(resumeData, options) {
      if (spy) {
        spy.resumeCalled = true;
        spy.resumeData = resumeData;
        spy.resumeOptions = options;
      }
      const resumeChunks = opts?.resume?.chunks ?? [];
      return {
        runId: opts?.resume?.runId ?? opts?.runId ?? "r1",
        fullStream:
          resumeChunks instanceof ReadableStream ? resumeChunks : chunksToStream(resumeChunks),
      };
    },
  };
}

async function collectParts(reasoner: Reasoner, turn: ReasonerTurn): Promise<ReasoningPart[]> {
  const parts: ReasoningPart[] = [];
  for await (const part of reasoner.stream(turn)) {
    parts.push(part);
  }
  return parts;
}

describe("fromMastraAgent", () => {
  it("maps happy path: deltas, tool-call, tool-result, finish:stop", async () => {
    const reasoner = fromMastraAgent(
      fakeAgent([
        textDelta("Hello "),
        textDelta("world."),
        toolCall("tc-1", "get_weather", { city: "NYC" }),
        toolResult("tc-1", "get_weather", { temp: 72 }),
        finish("stop"),
      ]),
    );

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

  it("maps error chunk to terminal error", async () => {
    const reasoner = fromMastraAgent(
      fakeAgent([textDelta("partial"), errorChunk(new Error("provider failed"))]),
    );

    const parts = await collectParts(reasoner, baseTurn());

    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: "text-delta", text: "partial" });
    expect(parts[1]?.type).toBe("error");
    if (parts[1]?.type === "error") {
      expect(parts[1].cause.message).toBe("provider failed");
      expect(parts[1].recoverable).toBe(false);
    }
  });

  it("maps abnormal finish (content-filter) to terminal error", async () => {
    const reasoner = fromMastraAgent(fakeAgent([finish("content-filter")]));

    const parts = await collectParts(reasoner, baseTurn());

    expect(parts).toHaveLength(1);
    expect(parts[0]?.type).toBe("error");
    if (parts[0]?.type === "error") {
      expect(parts[0].cause.message).toBe(
        "Mastra provider did not complete normally: content-filter",
      );
      expect(parts[0].recoverable).toBe(false);
    }
  });

  it("maps finish(length) to finish with accumulated text", async () => {
    const reasoner = fromMastraAgent(fakeAgent([textDelta("truncated"), finish("length")]));

    const parts = await collectParts(reasoner, baseTurn());

    expect(parts).toEqual([
      { type: "text-delta", text: "truncated" },
      { type: "finish", reason: "length", text: "truncated" },
    ]);
  });

  it("drops reasoning-delta and workflow chunks", async () => {
    const reasoner = fromMastraAgent(
      fakeAgent([
        { type: "reasoning-delta", payload: { text: "thinking..." } },
        { type: "workflow-step", payload: { step: 1 } },
        textDelta("answer"),
        finish("stop"),
      ]),
    );

    const parts = await collectParts(reasoner, baseTurn());

    expect(parts).toEqual([
      { type: "text-delta", text: "answer" },
      { type: "finish", reason: "stop", text: "answer" },
    ]);
  });

  it("yields first text-delta before source stream completes (no buffering)", async () => {
    const { stream, release } = delayedStream(textDelta("immediate"));
    const reasoner = fromMastraAgent(fakeAgent(stream));

    const iterator = reasoner.stream(baseTurn())[Symbol.asyncIterator]();
    const first = await iterator.next();

    expect(first.done).toBe(false);
    expect(first.value).toEqual({ type: "text-delta", text: "immediate" });
    release();
  });

  it("returns without yielding when turn.signal is already aborted (barge-in)", async () => {
    const controller = new AbortController();
    controller.abort();
    const turn: ReasonerTurn = { ...baseTurn(), signal: controller.signal };

    const reasoner = fromMastraAgent(
      fakeAgent([textDelta("should not appear"), finish("stop")]),
    );

    const parts = await collectParts(reasoner, turn);

    expect(parts).toEqual([]);
  });

  it("maps tool-call-suspended to terminal suspended part", async () => {
    const reasoner = fromMastraAgent(
      fakeAgent(
        [
          {
            type: "tool-call-suspended",
            payload: { suspendPayload: { message: "Approve the refund?" } },
          },
        ],
        { runId: "run-1" },
      ),
    );

    const parts = await collectParts(reasoner, baseTurn());

    expect(parts).toEqual([
      {
        type: "suspended",
        runId: "run-1",
        prompt: "Approve the refund?",
        payload: { message: "Approve the refund?" },
      },
    ]);
  });

  it("resume turn calls resumeStream instead of stream", async () => {
    const spy = {
      streamCalled: false,
      resumeCalled: false,
      resumeData: undefined as unknown,
      resumeOptions: undefined as
        | { runId: string; toolCallId?: string; abortSignal?: AbortSignal }
        | undefined,
    };
    const reasoner = fromMastraAgent(
      fakeAgent([], {
        resume: { chunks: [textDelta("Done."), finish("stop")], runId: "run-1" },
        spy,
      }),
    );

    const turn: ReasonerTurn = {
      ...baseTurn(),
      resume: { runId: "run-1", data: { approved: true } },
    };
    const parts = await collectParts(reasoner, turn);

    expect(spy.streamCalled).toBe(false);
    expect(spy.resumeCalled).toBe(true);
    expect(spy.resumeData).toEqual({ approved: true });
    expect(spy.resumeOptions).toEqual({ runId: "run-1", abortSignal: turn.signal });
    expect(parts).toEqual([
      { type: "text-delta", text: "Done." },
      { type: "finish", reason: "stop", text: "Done." },
    ]);
  });
});
