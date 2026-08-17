// SPDX-License-Identifier: MIT
//
// Validation contract for the HistoryCompactor managed transition (RFC:
// Continuous-interaction architecture §2.4/§4 L3) — replaces the bare
// trimHistory() slice() with an observable, off-path, re-entrancy-guarded swap.

import { describe, expect, it } from "vitest";
import {
  InMemoryReasonerSessionStore,
  PipelineBusImpl,
  Route,
  type EndOfSpeechPacket,
  type HistoryCompactionPacket,
  type HistoryCompactor,
  type Reasoner,
  type ReasonerMessage,
  type ReasonerTurn,
  type ReasoningPart,
} from "@kuralle-syrinx/core";
import { ReasoningBridge } from "./index.js";

const SEED_CONSTRAINT = "SEED_CONSTRAINT: caller is org-42, open P1 outage ticket 8842.";

/** Replies with a short, deterministic acknowledgement and records the messages it saw. */
class RecordingReasoner implements Reasoner {
  readonly seenMessages: Array<readonly ReasonerMessage[]> = [];
  stream(turn: ReasonerTurn): AsyncIterable<ReasoningPart> {
    this.seenMessages.push(turn.messages);
    return (async function* (): AsyncGenerator<ReasoningPart> {
      yield { type: "text-delta", text: "ok" };
      yield { type: "finish", reason: "stop", text: "ok" };
    })();
  }
}

function baseConfig(): Record<string, unknown> {
  return { api_key: "test-key", model: "gpt-test", system_prompt: "test", retry_max_attempts: 1, timeout_ms: 1000 };
}

function turnComplete(contextId: string, text: string): EndOfSpeechPacket {
  return { kind: "eos.turn_complete", contextId, timestampMs: Date.now(), text, transcripts: [] };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function compactionPackets(packets: Array<{ packet: unknown }>): HistoryCompactionPacket[] {
  return packets
    .map(({ packet }) => packet as { kind?: string })
    .filter((packet): packet is HistoryCompactionPacket => packet.kind === "history_compaction");
}

/** Folds every message's content into one system message — proves the swap mechanics
 * (boundary, splice, persist) without depending on a real LLM's summarization quality. */
const concatenatingCompactor: HistoryCompactor = {
  compact: async (history) => [{ role: "system", content: history.map((m) => m.content).filter(Boolean).join(" | ") }],
};

describe("HistoryCompactor — managed transition", () => {
  it("keeps a turn-1 constraint represented in history after driving past the high-water mark", async () => {
    const store = new InMemoryReasonerSessionStore();
    store.save("session-compact", [{ role: "system", content: SEED_CONSTRAINT }]);
    const reasoner = new RecordingReasoner();
    const packets: Array<{ route: Route; packet: unknown }> = [];
    const bridge = new ReasoningBridge(reasoner, {
      sessionStore: store,
      sessionId: "session-compact",
      historyCompaction: { compactor: concatenatingCompactor, highWaterTokens: 40, retainMessages: 4 },
    });
    const bus = new PipelineBusImpl({ onPacket: (route, packet) => packets.push({ route, packet }) });
    const drain = bus.start();
    await bridge.initialize(bus, baseConfig());

    for (let turn = 1; turn <= 6; turn += 1) {
      bus.push(Route.Main, turnComplete(`turn-${turn}`, `Details for turn number ${turn} of the call.`));
      await waitFor(() => reasoner.seenMessages.length === turn);
    }
    await waitFor(() => compactionPackets(packets).some((p) => p.phase === "committed"));

    // One more turn to observe what the reasoner is handed post-compaction.
    bus.push(Route.Main, turnComplete("turn-final", "One more thing."));
    await waitFor(() => reasoner.seenMessages.length === 7);
    const finalMessages = reasoner.seenMessages[reasoner.seenMessages.length - 1]!;
    expect(finalMessages.some((m) => m.role === "system" && m.content.includes(SEED_CONSTRAINT))).toBe(true);

    // history_compaction events: started then committed, with correct before/after sizes.
    const compactions = compactionPackets(packets);
    expect(compactions.some((p) => p.phase === "started" && p.beforeMessages > 0)).toBe(true);
    const committed = compactions.find((p) => p.phase === "committed");
    expect(committed).toBeDefined();
    expect(committed!.afterMessages).toBeDefined();
    expect(committed!.afterMessages!).toBeLessThan(committed!.beforeMessages);

    // Persisted snapshot after compaction equals the compacted (post-swap) history —
    // persistHistory() has snapshot, not append, semantics; ordering must put the swap first.
    const persisted = store.load("session-compact");
    expect(persisted.length).toBe(committed!.afterMessages);
    expect(persisted.some((m) => m.role === "system" && m.content.includes(SEED_CONSTRAINT))).toBe(true);

    bus.stop();
    await drain;
    await bridge.close();
  });

  it("red gate: without a compactor configured, behaviour is byte-identical to bare trimHistory() — the turn-1 constraint is silently dropped once history exceeds the trim window", async () => {
    const store = new InMemoryReasonerSessionStore();
    store.save("session-no-compact", [{ role: "system", content: SEED_CONSTRAINT }]);
    const reasoner = new RecordingReasoner();
    const bridge = new ReasoningBridge(reasoner, { sessionStore: store, sessionId: "session-no-compact" });
    const bus = new PipelineBusImpl();
    const drain = bus.start();
    await bridge.initialize(bus, { ...baseConfig(), max_history_turns: 2 });

    for (let turn = 1; turn <= 4; turn += 1) {
      bus.push(Route.Main, turnComplete(`turn-${turn}`, `Turn ${turn} text.`));
      await waitFor(() => reasoner.seenMessages.length === turn);
    }

    const persisted = store.load("session-no-compact");
    // maxHistoryTurns=2 → maxMessages=4 → bare slice(length-4) — the identical math
    // trimHistory() ran before this task, unchanged when no compactor is configured.
    expect(persisted).toHaveLength(4);
    expect(persisted.every((m) => !m.content.includes(SEED_CONSTRAINT))).toBe(true);
    expect(persisted).toEqual([
      { role: "user", content: "Turn 3 text." },
      { role: "assistant", content: "ok" },
      { role: "user", content: "Turn 4 text." },
      { role: "assistant", content: "ok" },
    ]);

    bus.stop();
    await drain;
    await bridge.close();
  });

  it("never severs a tool-call from its tool-result across the compaction boundary", async () => {
    const store = new InMemoryReasonerSessionStore();
    store.save("session-toolpair", [
      { role: "system", content: SEED_CONSTRAINT },
      { role: "user", content: "what's the fee?" },
      { role: "assistant", content: "", toolCallId: "call-1" },
      { role: "tool", content: "$10", toolCallId: "call-1" },
      { role: "user", content: "thanks" },
      { role: "assistant", content: "You're welcome." },
    ]);
    const reasoner = new RecordingReasoner();
    const packets: Array<{ route: Route; packet: unknown }> = [];
    const bridge = new ReasoningBridge(reasoner, {
      sessionStore: store,
      sessionId: "session-toolpair",
      // 6 seeded + 2 from the driven turn = 8 messages; retainMessages=5 → desired
      // boundary 3 lands between the tool-call (index 2) and its result (index 3).
      historyCompaction: { compactor: concatenatingCompactor, highWaterTokens: 5, retainMessages: 5 },
    });
    const bus = new PipelineBusImpl({ onPacket: (route, packet) => packets.push({ route, packet }) });
    const drain = bus.start();
    await bridge.initialize(bus, baseConfig());

    bus.push(Route.Main, turnComplete("turn-1", "one more question"));
    await waitFor(() => reasoner.seenMessages.length === 1);
    await waitFor(() => compactionPackets(packets).some((p) => p.phase === "committed"));

    const persisted = store.load("session-toolpair");
    const byToolCallId = new Map<string, { call: boolean; result: boolean }>();
    for (const message of persisted) {
      if (message.toolCallId === undefined) continue;
      const entry = byToolCallId.get(message.toolCallId) ?? { call: false, result: false };
      if (message.role === "assistant") entry.call = true;
      if (message.role === "tool") entry.result = true;
      byToolCallId.set(message.toolCallId, entry);
    }
    for (const [toolCallId, { call, result }] of byToolCallId) {
      expect([call, result], `toolCallId ${toolCallId} must be either fully present or fully folded away`).toEqual([true, true]);
    }
    // The retained portion must have pulled the whole pair through raw (boundary
    // retreated to 2, so nothing summarized away the pair in this configuration).
    expect(persisted.some((m) => m.role === "assistant" && m.toolCallId === "call-1")).toBe(true);
    expect(persisted.some((m) => m.role === "tool" && m.toolCallId === "call-1")).toBe(true);

    bus.stop();
    await drain;
    await bridge.close();
  });

  it("guards re-entrancy: a trigger while a compaction is in flight is a no-op — exactly one compaction runs", async () => {
    const store = new InMemoryReasonerSessionStore();
    store.save("session-reentrant", [{ role: "system", content: SEED_CONSTRAINT }]);
    const reasoner = new RecordingReasoner();
    const packets: Array<{ route: Route; packet: unknown }> = [];
    let compactCallCount = 0;
    let resolveCompact: ((value: readonly ReasonerMessage[]) => void) | undefined;
    const controlledCompactor: HistoryCompactor = {
      compact: async () => {
        compactCallCount += 1;
        return await new Promise<readonly ReasonerMessage[]>((resolve) => {
          resolveCompact = resolve;
        });
      },
    };
    const bridge = new ReasoningBridge(reasoner, {
      sessionStore: store,
      sessionId: "session-reentrant",
      historyCompaction: { compactor: controlledCompactor, highWaterTokens: 5, retainMessages: 1 },
    });
    const bus = new PipelineBusImpl({ onPacket: (route, packet) => packets.push({ route, packet }) });
    const drain = bus.start();
    await bridge.initialize(bus, baseConfig());

    bus.push(Route.Main, turnComplete("turn-1", "first question here"));
    await waitFor(() => reasoner.seenMessages.length === 1);
    await waitFor(() => compactionPackets(packets).some((p) => p.phase === "started"));
    expect(compactCallCount).toBe(1);

    // Second turn completes while the first compaction is still unresolved.
    bus.push(Route.Main, turnComplete("turn-2", "second question here"));
    await waitFor(() => reasoner.seenMessages.length === 2);
    expect(compactCallCount).toBe(1);
    expect(compactionPackets(packets).filter((p) => p.phase === "started")).toHaveLength(1);

    resolveCompact!([{ role: "system", content: "summary" }]);
    await waitFor(() => compactionPackets(packets).some((p) => p.phase === "committed"));
    expect(compactCallCount).toBe(1);
    expect(compactionPackets(packets).filter((p) => p.phase === "committed")).toHaveLength(1);

    bus.stop();
    await drain;
    await bridge.close();
  });

  it("does not add latency to a turn issued while a compaction is in flight", async () => {
    const store = new InMemoryReasonerSessionStore();
    store.save("session-latency", [{ role: "system", content: SEED_CONSTRAINT }]);
    const reasoner = new RecordingReasoner();
    const packets: Array<{ route: Route; packet: unknown }> = [];
    const slowCompactor: HistoryCompactor = {
      compact: async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return [{ role: "system", content: "summary" }];
      },
    };
    const bridge = new ReasoningBridge(reasoner, {
      sessionStore: store,
      sessionId: "session-latency",
      historyCompaction: { compactor: slowCompactor, highWaterTokens: 5, retainMessages: 1 },
    });
    const bus = new PipelineBusImpl({ onPacket: (route, packet) => packets.push({ route, packet }) });
    const drain = bus.start();
    await bridge.initialize(bus, baseConfig());

    bus.push(Route.Main, turnComplete("turn-1", "trigger compaction"));
    await waitFor(() => reasoner.seenMessages.length === 1);
    await waitFor(() => compactionPackets(packets).some((p) => p.phase === "started"));

    const startedMs = Date.now();
    bus.push(Route.Main, turnComplete("turn-2", "should not wait on compaction"));
    await waitFor(() =>
      packets.some(({ packet }) => (packet as { kind?: string }).kind === "llm.done" && (packet as { contextId?: string }).contextId === "turn-2"),
    );
    const elapsedMs = Date.now() - startedMs;
    expect(elapsedMs).toBeLessThan(150); // well under the 300ms in-flight compaction delay

    await waitFor(() => compactionPackets(packets).some((p) => p.phase === "committed"), 2000);

    bus.stop();
    await drain;
    await bridge.close();
  });
});
