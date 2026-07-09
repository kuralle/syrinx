// SPDX-License-Identifier: MIT
// Regression guard (RL-WBS-1): a backend whose next() REJECTS (throws) — e.g. an adapter that
// throws AbortError on barge-in — must NOT hang the hedge race; it fails over / surfaces an error.
import { describe, expect, it } from "vitest";
import { HedgedReasoner } from "./reasoner-hedge.js";
import type { Reasoner, ReasonerTurn, ReasoningPart } from "./reasoner.js";
import type { Scheduler } from "./scheduler.js";

class ThrowingReasoner implements Reasoner {
  async *stream(_turn: ReasonerTurn): AsyncGenerator<ReasoningPart> {
    throw new Error("backend boom"); // rejects on first next()
  }
}
class GoodReasoner implements Reasoner {
  async *stream(_turn: ReasonerTurn): AsyncGenerator<ReasoningPart> {
    yield { type: "text-delta", text: "backup ok" };
    yield { type: "finish", reason: "stop", text: "backup ok" };
  }
}
// scheduler that fires immediately so backup is available
const eagerScheduler: Scheduler = { schedule: (_k, _ms, cb) => cb(), cancel: () => {} };

function turn(): ReasonerTurn {
  return { userText: "hi", messages: [], signal: new AbortController().signal };
}

describe("hedge reject repro", () => {
  it("does not hang when the primary backend THROWS (rejects next())", async () => {
    const hedged = new HedgedReasoner({
      primary: new ThrowingReasoner(),
      backup: new GoodReasoner(),
      hedgeAfterMs: 0,
      scheduler: eagerScheduler,
    });
    const parts: string[] = [];
    const collect = (async () => {
      for await (const p of hedged.stream(turn())) {
        if (p.type === "text-delta") parts.push(p.text);
      }
    })();
    const timeout = new Promise((_r, rej) => setTimeout(() => rej(new Error("HUNG: HedgedReasoner never completed")), 3000));
    await Promise.race([collect, timeout]);
    // If it doesn't hang, it should have failed over to the backup.
    expect(parts).toContain("backup ok");
  });
});
