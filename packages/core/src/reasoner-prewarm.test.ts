// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { VoiceAgentSession, type VoicePlugin } from "./index.js";
import type { ConversationMetricPacket } from "./packets.js";
import { assertComposedReasoner } from "./reasoner-composed.guard.js";
import { HedgedReasoner } from "./reasoner-hedge.js";
import { RoutingReasoner } from "./reasoner-route.js";
import type { Reasoner, ReasonerPrewarmContext, ReasoningPart } from "./reasoner.js";

function emptyStream(): AsyncIterable<ReasoningPart> {
  return (async function* (): AsyncGenerator<ReasoningPart> {})();
}

function leafReasoner(id: string, onPrewarm?: (ctx: ReasonerPrewarmContext) => Promise<void>): Reasoner {
  void id;
  return {
    async prewarm(ctx) {
      await onPrewarm?.(ctx);
    },
    stream: () => emptyStream(),
  };
}

describe("Reasoner.prewarm capability contract", () => {
  it("compile guard: wrappers satisfy ComposedReasoner", () => {
    const hedge = new HedgedReasoner({
      primary: leafReasoner("primary"),
      backup: leafReasoner("backup"),
      hedgeAfterMs: 50,
    });
    const router = new RoutingReasoner({
      routes: [{ id: "only", reasoner: hedge }],
      classify: () => "only",
    });
    expect(assertComposedReasoner(hedge)).toBe(hedge);
    expect(assertComposedReasoner(router)).toBe(router);
  });

  it("RoutingReasoner(HedgedReasoner(a,b)) with three leaf reasoners each receive prewarm exactly once", async () => {
    const prewarmCounts = new Map<string, number>();
    const track = (id: string) => async (_ctx: ReasonerPrewarmContext): Promise<void> => {
      prewarmCounts.set(id, (prewarmCounts.get(id) ?? 0) + 1);
    };

    const primary = leafReasoner("primary", track("primary"));
    const backup = leafReasoner("backup", track("backup"));
    const routeLeaf = leafReasoner("route-leaf", track("route-leaf"));

    const hedged = new HedgedReasoner({ primary, backup, hedgeAfterMs: 50 });
    const router = new RoutingReasoner({
      routes: [
        { id: "fast", reasoner: hedged },
        { id: "deep", reasoner: routeLeaf },
      ],
      classify: () => "fast",
    });

    await router.prewarm({ sessionId: "sess-1" });

    expect(prewarmCounts.get("primary")).toBe(1);
    expect(prewarmCounts.get("backup")).toBe(1);
    expect(prewarmCounts.get("route-leaf")).toBe(1);
  });

  it("one route prewarm rejecting does not prevent the others", async () => {
    const warmed: string[] = [];

    const primary = leafReasoner("primary", async () => {
      warmed.push("primary");
    });
    const backup = leafReasoner("backup", async () => {
      warmed.push("backup");
    });
    const rejector = leafReasoner("rejector", async () => {
      throw new Error("warm failed");
    });

    const hedged = new HedgedReasoner({ primary, backup, hedgeAfterMs: 50 });
    const router = new RoutingReasoner({
      routes: [
        { id: "fast", reasoner: hedged },
        { id: "bad", reasoner: rejector },
      ],
      classify: () => "fast",
    });

    await expect(router.prewarm({ sessionId: "sess-2" })).resolves.toBeUndefined();
    expect(warmed.sort()).toEqual(["backup", "primary"]);
  });

  it("HedgedReasoner forwards prewarm to both primary and backup", async () => {
    const warmed: string[] = [];
    const hedged = new HedgedReasoner({
      primary: leafReasoner("primary", async () => {
        warmed.push("primary");
      }),
      backup: leafReasoner("backup", async () => {
        warmed.push("backup");
      }),
      hedgeAfterMs: 50,
    });

    await hedged.prewarm({ sessionId: "sess-3" });
    expect(warmed.sort()).toEqual(["backup", "primary"]);
  });

  it("reasoner without prewarm is a no-op for wrapper prewarm", async () => {
    const streamOnly: Reasoner = { stream: () => emptyStream() };
    const hedged = new HedgedReasoner({
      primary: streamOnly,
      backup: streamOnly,
      hedgeAfterMs: 50,
    });
    await expect(hedged.prewarm({ sessionId: "sess-4" })).resolves.toBeUndefined();
  });
});

describe("VoiceAgentSession.prewarm reasoner chain", () => {
  async function closeSession(session: VoiceAgentSession): Promise<void> {
    await session.close();
  }

  it("emits prewarm.failed when plugin prewarm rejects", async () => {
    const metrics: ConversationMetricPacket[] = [];
    const plugin: VoicePlugin = {
      async initialize() {},
      async close() {},
      prewarm: async () => {
        throw new Error("warm failed");
      },
    };
    const session = new VoiceAgentSession({ plugins: { bridge: {} } });
    session.registerPlugin("bridge", plugin);
    session.bus.on("metric.conversation", (pkt) => {
      metrics.push(pkt as ConversationMetricPacket);
    });
    await session.start();
    await session.prewarm();
    expect(metrics.some((metric) => metric.name === "prewarm.failed" && metric.value === "bridge")).toBe(true);
    await closeSession(session);
  });
});
