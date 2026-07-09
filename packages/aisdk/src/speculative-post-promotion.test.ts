// SPDX-License-Identifier: MIT
//
// Regression guard (S1-01, RFC C2): when a speculative draft is promoted MID-STREAM,
// deltas produced AFTER the promotion must go live, not stay buffered. The speculative
// side-effect gate must re-check commit state per push — hoisting it to a single value
// captured at generation start loses the post-promotion tail (incl. llm.done).

import { describe, expect, it } from "vitest";
import { PipelineBusImpl, Route } from "@kuralle-syrinx/core";
import type { EndOfSpeechPacket } from "@kuralle-syrinx/core";
import type { FinishReason, TextStreamPart, ToolSet } from "ai";
import { fromStreamFactory } from "./from-ai-sdk.js";
import { ReasoningBridge } from "./index.js";

const ZERO_USAGE = {
  inputTokens: 0,
  inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokens: 0,
  outputTokenDetails: { reasoningTokens: 0 },
  totalTokens: 0,
  reasoningTokens: 0,
  cachedInputTokens: 0,
} as unknown as Record<string, unknown>;

function textDelta(text: string): TextStreamPart<ToolSet> {
  return { type: "text-delta", id: "0", text, providerMetadata: undefined } as TextStreamPart<ToolSet>;
}
function finish(finishReason: FinishReason): TextStreamPart<ToolSet> {
  return { type: "finish", finishReason, totalUsage: ZERO_USAGE, usage: ZERO_USAGE, providerMetadata: undefined, response: {} } as unknown as TextStreamPart<ToolSet>;
}
function eosInterim(contextId: string, text: string) {
  return { kind: "eos.interim" as const, contextId, timestampMs: Date.now(), text };
}
function turnComplete(contextId: string, text: string): EndOfSpeechPacket {
  return { kind: "eos.turn_complete", contextId, timestampMs: Date.now(), text, transcripts: [] };
}
function baseConfig(): Record<string, unknown> {
  return { api_key: "test-key", model: "gpt-test", system_prompt: "test", retry_max_attempts: 1, timeout_ms: 1000 };
}
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timed out");
}

describe("S1 repro — post-promotion streaming", () => {
  it("a delta streamed AFTER a mid-stream promotion must still reach the bus", async () => {
    const packets: Array<{ route: Route; packet: unknown }> = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });

    const plugin = new ReasoningBridge(
      fromStreamFactory(async function* () {
        yield textDelta("first ");   // buffered while hypothesized
        await gate;                  // still streaming — pause BEFORE promotion completes
        yield textDelta("second");   // streamed AFTER promotion
        yield finish("stop");
      }),
      { speculative: true },
    );
    const bus = new PipelineBusImpl({ onPacket: (route, packet) => packets.push({ route, packet }) });
    const drain = bus.start();
    await plugin.initialize(bus, baseConfig());

    bus.push(Route.Main, eosInterim("turn-1", "hello there"));
    await new Promise((r) => setTimeout(r, 50)); // "first " buffered; generator paused at gate

    bus.push(Route.Main, turnComplete("turn-1", "hello there")); // promote (commit) mid-stream
    await new Promise((r) => setTimeout(r, 20));
    release(); // now let the generator stream the post-promotion delta

    await waitFor(() => packets.some((p) => (p.packet as { kind: string }).kind === "llm.done"));
    bus.stop();
    await drain;
    await plugin.close();

    const deltaTexts = packets
      .filter((p) => (p.packet as { kind: string }).kind === "llm.delta")
      .map((p) => (p.packet as { text: string }).text);

    // The post-promotion "second" delta MUST have reached the bus.
    expect(deltaTexts).toContain("second");
  });
});
