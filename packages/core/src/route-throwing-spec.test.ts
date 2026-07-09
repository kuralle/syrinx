// SPDX-License-Identifier: MIT
// Regression guard (RL-WBS-2): a mispredicted speculative route whose next() rejects must NOT leak an
// unhandled rejection (the abandoned specNext must be caught); and a throwing route must surface, not hang.
import { describe, expect, it } from "vitest";
import { RoutingReasoner } from "./reasoner-route.js";
import type { Reasoner, ReasonerTurn, ReasoningPart } from "./reasoner.js";

class ThrowingReasoner implements Reasoner {
  async *stream(_t: ReasonerTurn): AsyncGenerator<ReasoningPart> { throw new Error("spec boom"); }
}
class GoodReasoner implements Reasoner {
  constructor(private readonly text: string) {}
  async *stream(_t: ReasonerTurn): AsyncGenerator<ReasoningPart> {
    yield { type: "text-delta", text: this.text };
    yield { type: "finish", reason: "stop", text: this.text };
  }
}
function turn(): ReasonerTurn { return { userText: "hi", messages: [], signal: new AbortController().signal }; }

describe("route reject repro", () => {
  it("mispredicted speculative route that throws must not cause an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const router = new RoutingReasoner({
        routes: [
          { id: "fast", reasoner: new ThrowingReasoner() },     // speculated → will be abandoned
          { id: "deep", reasoner: new GoodReasoner("deep ok") }, // classify picks this (disagree)
        ],
        classify: () => "deep",
        speculateRouteId: "fast",
      });
      const parts: string[] = [];
      for await (const p of router.stream(turn())) if (p.type === "text-delta") parts.push(p.text);
      expect(parts).toEqual(["deep ok"]); // no part from the discarded spec route
      // let any dangling rejection surface
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled, `unhandled rejections: ${unhandled.map(String).join("; ")}`).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
