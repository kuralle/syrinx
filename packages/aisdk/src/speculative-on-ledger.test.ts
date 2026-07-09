// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
  PipelineBusImpl,
  Route,
  type EndOfSpeechPacket,
  type InMemoryIuLedger,
  type IncrementalUnitId,
} from "@kuralle-syrinx/core";
import type { FinishReason, TextStreamPart, ToolSet } from "ai";
import { fromStreamFactory } from "./from-ai-sdk.js";
import { ReasoningBridge } from "./index.js";

const ZERO_USAGE = {
  inputTokens: 0,
  inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokens: 0,
  outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
  totalTokens: 0,
};

type BridgeLedgerAccess = {
  iuLedger: InMemoryIuLedger;
  speculativeDraft: { id: IncrementalUnitId } | null;
};

function bridgeLedger(plugin: ReasoningBridge): BridgeLedgerAccess {
  return plugin as unknown as BridgeLedgerAccess;
}

describe("ReasoningBridge speculative-on-ledger", () => {
  it("eos.interim adds a hypothesized IU and matching eos.turn_complete commits it", async () => {
    const plugin = new ReasoningBridge(
      fromStreamFactory(async function* () {
        yield textDelta("Answer.");
        yield finish("stop");
      }),
      { speculative: true },
    );
    const bus = new PipelineBusImpl({ onPacket: () => {} });
    const drain = bus.start();
    await plugin.initialize(bus, baseConfig());
    const ledger = bridgeLedger(plugin);

    bus.push(Route.Main, eosInterim("turn-1", "hello"));
    await new Promise((resolve) => setTimeout(resolve, 30));

    const draftId = ledger.speculativeDraft?.id;
    expect(draftId).toEqual({ contextId: "turn-1", iuId: "turn-1", epoch: 1 });
    expect(ledger.iuLedger.get(draftId!)?.state).toBe("hypothesized");

    bus.push(Route.Main, turnComplete("turn-1", "hello"));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(ledger.iuLedger.get(draftId!)?.state).toBe("committed");
    bus.stop();
    await drain;
    await plugin.close();
  });

  it("eos.retracted revokes the hypothesized IU", async () => {
    const plugin = new ReasoningBridge(
      fromStreamFactory(async function* () {
        yield textDelta("Draft.");
        yield finish("stop");
      }),
      { speculative: true },
    );
    const bus = new PipelineBusImpl({ onPacket: () => {} });
    const drain = bus.start();
    await plugin.initialize(bus, baseConfig());
    const ledger = bridgeLedger(plugin);

    bus.push(Route.Main, eosInterim("turn-1", "book a"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const draftId = ledger.speculativeDraft?.id;
    expect(ledger.iuLedger.get(draftId!)?.state).toBe("hypothesized");

    bus.push(Route.Main, eosRetracted("turn-1"));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(ledger.iuLedger.get(draftId!)?.state).toBe("revoked");
    bus.stop();
    await drain;
    await plugin.close();
  });

  it("double-commit fires an iu_ledger anomaly on the bus", async () => {
    const packets: Array<{ route: Route; packet: unknown }> = [];
    const plugin = new ReasoningBridge(
      fromStreamFactory(async function* () {
        yield textDelta("Answer.");
        yield finish("stop");
      }),
      { speculative: true },
    );
    const bus = new PipelineBusImpl({ onPacket: (route, packet) => packets.push({ route, packet }) });
    const drain = bus.start();
    await plugin.initialize(bus, baseConfig());
    const ledger = bridgeLedger(plugin);

    bus.push(Route.Main, eosInterim("turn-1", "hello"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const draftId = ledger.speculativeDraft?.id;
    expect(draftId).toBeDefined();

    bus.push(Route.Main, turnComplete("turn-1", "hello"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ledger.iuLedger.get(draftId!)?.state).toBe("committed");

    ledger.iuLedger.commit(draftId!);
    await waitFor(() =>
      packets.some(
        ({ packet }) =>
          (packet as { kind?: string; component?: string }).kind === "llm.error" &&
          (packet as { component?: string }).component === "iu_ledger",
      ),
    );

    expect(packets).toContainEqual({
      route: Route.Background,
      packet: expect.objectContaining({
        kind: "llm.error",
        component: "iu_ledger",
        contextId: "turn-1",
        isRecoverable: true,
      }),
    });
    bus.stop();
    await drain;
    await plugin.close();
  });

  it("assigns monotonic epoch across distinct contextIds", async () => {
    const plugin = new ReasoningBridge(
      fromStreamFactory(async function* () {
        yield textDelta("Answer.");
        yield finish("stop");
      }),
      { speculative: true },
    );
    const bus = new PipelineBusImpl({ onPacket: () => {} });
    const drain = bus.start();
    await plugin.initialize(bus, baseConfig());
    const ledger = bridgeLedger(plugin);

    bus.push(Route.Main, eosInterim("ctx-a", "first"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const idA = ledger.speculativeDraft?.id;
    bus.push(Route.Main, turnComplete("ctx-a", "first"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    bus.push(Route.Main, eosInterim("ctx-b", "second"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const idB = ledger.speculativeDraft?.id;

    expect(idA?.epoch).toBe(1);
    expect(idB?.epoch).toBe(2);
    expect(idB!.epoch).toBeGreaterThan(idA!.epoch);
    bus.stop();
    await drain;
    await plugin.close();
  });
});

function baseConfig(): Record<string, unknown> {
  return {
    api_key: "test-key",
    model: "gpt-test",
    system_prompt: "test",
    retry_max_attempts: 1,
    timeout_ms: 1000,
  };
}

function turnComplete(contextId: string, text: string): EndOfSpeechPacket {
  return { kind: "eos.turn_complete", contextId, timestampMs: Date.now(), text, transcripts: [] };
}

function eosInterim(contextId: string, text: string): { kind: "eos.interim"; contextId: string; timestampMs: number; text: string } {
  return { kind: "eos.interim", contextId, timestampMs: Date.now(), text };
}

function eosRetracted(contextId: string): { kind: "eos.retracted"; contextId: string; timestampMs: number } {
  return { kind: "eos.retracted", contextId, timestampMs: Date.now() };
}

function textDelta(text: string): TextStreamPart<ToolSet> {
  return { type: "text-delta", id: "0", text, providerMetadata: undefined } as TextStreamPart<ToolSet>;
}

function finish(finishReason: FinishReason, rawFinishReason?: string): TextStreamPart<ToolSet> {
  return {
    type: "finish",
    finishReason,
    rawFinishReason,
    totalUsage: ZERO_USAGE,
    usage: ZERO_USAGE,
    providerMetadata: undefined,
    response: {},
  } as TextStreamPart<ToolSet>;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1000) throw new Error("Timed out waiting for packet");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}