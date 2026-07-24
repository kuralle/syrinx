// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import type { UsageRecordedPacket } from "./packets.js";
import type { PriceCatalog } from "./pricing.js";
import { SpendCapGuard } from "./spend-cap.js";

const catalog: PriceCatalog = {
  source: "test",
  version: "0",
  stt: { "deepgram/nova-3": { usdPerAudioSecond: 0.1 } },
  llm: {
    "openai/gpt-4.1-mini": {
      usdPer1MInputTokens: 1,
      usdPer1MOutputTokens: 1,
    },
  },
  tts: { "cartesia/sonic-3": { usdPer1MCharacters: 1_000_000 } }, // $1 per character for easy math
};

function usage(fields: Omit<UsageRecordedPacket, "kind" | "timestampMs">): UsageRecordedPacket {
  return { kind: "usage.recorded", timestampMs: 1, ...fields };
}

describe("SpendCapGuard", () => {
  it("stays under the cap until a packet crosses it, then exceeds exactly once at the crossing", () => {
    const guard = new SpendCapGuard({ maxUsd: 1.0, catalog });

    guard.record(
      usage({
        contextId: "t1",
        stage: "stt",
        provider: "deepgram",
        model: "nova-3",
        audioSeconds: 5, // $0.50
      }),
    );
    expect(guard.check()).toEqual({ exceeded: false, spentUsd: 0.5 });

    guard.record(
      usage({
        contextId: "t2",
        stage: "stt",
        provider: "deepgram",
        model: "nova-3",
        audioSeconds: 4, // +$0.40 → $0.90
      }),
    );
    expect(guard.check()).toEqual({ exceeded: false, spentUsd: 0.9 });

    guard.record(
      usage({
        contextId: "t3",
        stage: "tts",
        provider: "cartesia",
        model: "sonic-3",
        characters: 0.2, // +$0.20 → $1.10
      }),
    );
    const crossed = guard.check();
    expect(crossed.exceeded).toBe(true);
    expect(crossed.spentUsd).toBeCloseTo(1.1, 10);

    // Further usage keeps exceeded; check remains read-only / non-mutating
    guard.record(
      usage({
        contextId: "t4",
        stage: "stt",
        provider: "deepgram",
        model: "nova-3",
        audioSeconds: 1,
      }),
    );
    expect(guard.check().exceeded).toBe(true);
    expect(guard.check().spentUsd).toBeCloseTo(1.2, 10);
  });

  it("does not count unpriced usage toward spend", () => {
    const guard = new SpendCapGuard({ maxUsd: 0.01, catalog });
    guard.record(
      usage({
        contextId: "t1",
        stage: "stt",
        provider: "unknown",
        model: "x",
        audioSeconds: 100,
      }),
    );
    expect(guard.check()).toEqual({ exceeded: false, spentUsd: 0 });
  });

  it("check does not mutate state (observe/control separation)", () => {
    const guard = new SpendCapGuard({ maxUsd: 10, catalog });
    guard.record(
      usage({
        contextId: "t1",
        stage: "stt",
        provider: "deepgram",
        model: "nova-3",
        audioSeconds: 2,
      }),
    );
    const a = guard.check();
    const b = guard.check();
    expect(a).toEqual(b);
    expect(a).toEqual({ exceeded: false, spentUsd: 0.2 });
  });

  it("rejects invalid maxUsd", () => {
    expect(() => new SpendCapGuard({ maxUsd: -1, catalog })).toThrow(/maxUsd/);
    expect(() => new SpendCapGuard({ maxUsd: Number.NaN, catalog })).toThrow(/maxUsd/);
  });
});
