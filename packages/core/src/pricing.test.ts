// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import type { UsageRecordedPacket } from "./packets.js";
import { costOf, DEFAULT_PRICE_CATALOG, type PriceCatalog } from "./pricing.js";

function usage(fields: Omit<UsageRecordedPacket, "kind" | "timestampMs">): UsageRecordedPacket {
  return { kind: "usage.recorded", timestampMs: 1, ...fields };
}

describe("costOf", () => {
  it("computes STT cost from audioSeconds × catalog rate", () => {
    const packet = usage({
      contextId: "t1",
      stage: "stt",
      provider: "deepgram",
      model: "nova-3",
      audioSeconds: 60,
    });
    const result = costOf(packet, DEFAULT_PRICE_CATALOG);
    expect(result.unpriced).toBeUndefined();
    expect(result.usd).toBeCloseTo(0.0077, 10);
  });

  it("computes LLM cost from input/output tokens", () => {
    const packet = usage({
      contextId: "t1",
      stage: "llm",
      provider: "openai",
      model: "gpt-4.1-mini",
      inputTokens: 1_000_000,
      outputTokens: 500_000,
    });
    const result = costOf(packet, DEFAULT_PRICE_CATALOG);
    expect(result.usd).toBeCloseTo(0.4 + 0.8, 10);
  });

  it("computes TTS cost from characters", () => {
    const packet = usage({
      contextId: "t1",
      stage: "tts",
      provider: "cartesia",
      model: "sonic-3",
      characters: 1_000_000,
    });
    const result = costOf(packet, DEFAULT_PRICE_CATALOG);
    expect(result.usd).toBe(50);
  });

  it("returns unpriced (not 0) for unknown provider/model", () => {
    const packet = usage({
      contextId: "t1",
      stage: "stt",
      provider: "acme",
      model: "mystery",
      audioSeconds: 10,
    });
    expect(costOf(packet, DEFAULT_PRICE_CATALOG)).toEqual({ usd: null, unpriced: true });
  });

  it("prices new catalog providers (google STT, gemini TTS)", () => {
    const stt = costOf(
      usage({
        contextId: "t1",
        stage: "stt",
        provider: "google",
        model: "latest_long",
        audioSeconds: 60,
      }),
      DEFAULT_PRICE_CATALOG,
    );
    expect(stt.unpriced).toBeUndefined();
    expect(stt.usd).toBeCloseTo(0.016, 10);

    const tts = costOf(
      usage({
        contextId: "t1",
        stage: "tts",
        provider: "gemini",
        model: "gemini-2.5-flash-preview-tts",
        characters: 1_000_000,
      }),
      DEFAULT_PRICE_CATALOG,
    );
    expect(tts.unpriced).toBeUndefined();
    expect(tts.usd).toBe(0.5);
  });

  it("returns unpriced for grok/epsilon providers with no public list price", () => {
    expect(
      costOf(
        usage({
          contextId: "t1",
          stage: "stt",
          provider: "grok",
          model: "stt",
          audioSeconds: 10,
        }),
        DEFAULT_PRICE_CATALOG,
      ),
    ).toEqual({ usd: null, unpriced: true });
    expect(
      costOf(
        usage({
          contextId: "t1",
          stage: "tts",
          provider: "grok",
          model: "eve",
          characters: 1000,
        }),
        DEFAULT_PRICE_CATALOG,
      ),
    ).toEqual({ usd: null, unpriced: true });
    expect(
      costOf(
        usage({
          contextId: "t1",
          stage: "tts",
          provider: "epsilon",
          model: "epsilon-tts",
          characters: 1000,
        }),
        DEFAULT_PRICE_CATALOG,
      ),
    ).toEqual({ usd: null, unpriced: true });
  });

  it("returns unpriced when provider or model is missing", () => {
    const packet = usage({
      contextId: "t1",
      stage: "llm",
      inputTokens: 100,
      outputTokens: 10,
    });
    expect(costOf(packet, DEFAULT_PRICE_CATALOG)).toEqual({ usd: null, unpriced: true });
  });

  it("returns 0 for declared-local models", () => {
    expect(
      costOf(
        usage({
          contextId: "t1",
          stage: "stt",
          provider: "local",
          model: "whisper",
          audioSeconds: 100,
        }),
        DEFAULT_PRICE_CATALOG,
      ),
    ).toEqual({ usd: 0 });
    expect(
      costOf(
        usage({
          contextId: "t1",
          stage: "tts",
          provider: "local",
          model: "tts",
          characters: 50_000,
        }),
        DEFAULT_PRICE_CATALOG,
      ),
    ).toEqual({ usd: 0 });
    expect(
      costOf(
        usage({
          contextId: "t1",
          stage: "llm",
          provider: "local",
          model: "llm",
          inputTokens: 9_000,
          outputTokens: 1_000,
        }),
        DEFAULT_PRICE_CATALOG,
      ),
    ).toEqual({ usd: 0 });
  });

  it("uses a custom catalog when provided", () => {
    const catalog: PriceCatalog = {
      source: "test",
      version: "0",
      stt: { "deepgram/nova-3": { usdPerAudioSecond: 1 } },
      llm: {},
      tts: {},
    };
    expect(
      costOf(
        usage({
          contextId: "t1",
          stage: "stt",
          provider: "deepgram",
          model: "nova-3",
          audioSeconds: 2.5,
        }),
        catalog,
      ),
    ).toEqual({ usd: 2.5 });
  });
});
