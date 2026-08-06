// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { InMemoryIuLedger } from "./iu-ledger.js";
import {
  applyCommittedPrefix,
  buildTranscriptView,
  formatTranscriptIuId,
  iuStorageKey,
} from "./transcript-views.js";

describe("transcript-views", () => {
  it("applyCommittedPrefix truncates at committed chars", () => {
    expect(applyCommittedPrefix("Hello world", { chars: 5 })).toBe("Hello");
  });

  it("buildTranscriptView excludes revoked and backchannel contexts", () => {
    const ledger = new InMemoryIuLedger();
    const user = { contextId: "t1", iuId: "t1", epoch: 1 };
    const revoked = { contextId: "t2", iuId: "t2", epoch: 1 };
    ledger.add({ id: user, kind: "user_turn", state: "committed" });
    ledger.add({ id: revoked, kind: "user_turn", state: "revoked" });
    const textByKey = new Map<string, string>([
      [iuStorageKey(user), "hello"],
      [iuStorageKey(revoked), "gone"],
    ]);
    const view = buildTranscriptView(
      ledger,
      [user, revoked],
      textByKey,
      (ctx) => ctx === "bc",
      undefined,
      (state) => state === "committed",
    );
    expect(view).toEqual([
      {
        role: "user",
        text: "hello",
        iuId: formatTranscriptIuId(user),
        state: "committed",
      },
    ]);
  });
});
