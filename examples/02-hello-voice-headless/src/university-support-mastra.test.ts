// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { PipelineBusImpl, Route } from "@kuralle-syrinx/core";
import type { EndOfSpeechPacket, LlmResponseDonePacket } from "@kuralle-syrinx/core";
import { ReasoningBridge } from "@kuralle-syrinx/aisdk";
import { fromMastraAgent, type MastraAgentLike, type MastraChunk } from "@kuralle-syrinx/mastra";

function textDelta(text: string): MastraChunk {
  return { type: "text-delta", payload: { text } };
}

function finish(reason: string): MastraChunk {
  return { type: "finish", payload: { stepResult: { reason } } };
}

function chunksToStream(chunks: MastraChunk[]): ReadableStream<MastraChunk> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function scriptedAgent(chunks: MastraChunk[]): MastraAgentLike {
  return {
    async stream() {
      return {
        runId: "r1",
        fullStream: chunksToStream(chunks),
      };
    },
    async resumeStream() {
      return {
        runId: "r1",
        fullStream: chunksToStream(chunks),
      };
    },
  };
}

function turnComplete(contextId: string, text: string): EndOfSpeechPacket {
  return {
    kind: "eos.turn_complete",
    contextId,
    timestampMs: Date.now(),
    text,
    transcripts: [],
  };
}

function baseConfig(): Record<string, unknown> {
  return {
    max_history_turns: 20,
    timeout_ms: 30_000,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1000) {
      throw new Error("Timed out waiting for packet");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("university support Mastra bridge", () => {
  it("emits llm.done through the bus with a scripted Mastra agent", async () => {
    const packets: Array<{ route: Route; packet: unknown }> = [];
    const plugin = new ReasoningBridge(
      fromMastraAgent(scriptedAgent([
        textDelta("I can help with your Biology 101 late add."),
        finish("stop"),
      ])),
    );
    const bus = new PipelineBusImpl({ onPacket: (route, packet) => packets.push({ route, packet }) });
    const drain = bus.start();

    await plugin.initialize(bus, baseConfig());
    bus.push(Route.Main, turnComplete("turn-1", "Can I still add Biology 101?"));

    await waitFor(() => packets.some(({ packet }) => (packet as { kind?: string }).kind === "llm.done"));
    bus.stop();
    await drain;
    await plugin.close();

    expect(packets).toContainEqual({
      route: Route.Main,
      packet: expect.objectContaining({
        kind: "llm.done",
        contextId: "turn-1",
        text: "I can help with your Biology 101 late add.",
      } satisfies Partial<LlmResponseDonePacket>),
    });
  });
});
