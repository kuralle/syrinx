// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from "vitest";

import { DEFAULT_RETRY_CONFIG, VOICE_PROVIDER_RETRY_CONFIG, readProviderRetryConfig, readRetryConfig, retryDelayMs, retryDelayWithJitterMs, waitForRetryDelay } from "./retry.js";

describe("retry helpers", () => {
  it("reads bounded retry config from plugin config", () => {
    expect(
      readRetryConfig({
        retry_max_attempts: 5,
        retry_base_delay_ms: 100,
        retry_max_delay_ms: 900,
      }),
    ).toEqual({
      maxAttempts: 5,
      baseDelayMs: 100,
      maxDelayMs: 900,
    });
  });

  it("backs off exponentially up to the configured cap", () => {
    const config = {
      maxAttempts: 5,
      baseDelayMs: 100,
      maxDelayMs: 250,
    };
    expect(retryDelayMs(1, config)).toBe(100);
    expect(retryDelayMs(2, config)).toBe(200);
    expect(retryDelayMs(3, config)).toBe(250);
  });

  it("applies equal jitter: half the deterministic delay plus a random half", () => {
    const config = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1000 };
    // attempt 2 deterministic = 200 → equal-jitter range [100, 200].
    expect(retryDelayWithJitterMs(2, config, () => 0)).toBe(100);
    expect(retryDelayWithJitterMs(2, config, () => 1)).toBe(200);
    expect(retryDelayWithJitterMs(2, config, () => 0.5)).toBe(150);
  });

  it("can be aborted while waiting", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const wait = waitForRetryDelay(
      1,
      {
        maxAttempts: 3,
        baseDelayMs: 1000,
        maxDelayMs: 1000,
      },
      controller.signal,
    );

    controller.abort();
    await expect(wait).rejects.toMatchObject({ name: "AbortError" });
    vi.useRealTimers();
  });

  it("voice-provider profile keeps fast first reconnect but raises the backoff cap", () => {
    // Fast first reconnect (no multi-second floor → no dead air on transient blips)...
    expect(retryDelayMs(1, VOICE_PROVIDER_RETRY_CONFIG)).toBe(250);
    expect(retryDelayMs(1, VOICE_PROVIDER_RETRY_CONFIG)).toBe(DEFAULT_RETRY_CONFIG.baseDelayMs);
    // ...but a patient cap for persistent provider failure (vs the 2s default).
    expect(retryDelayMs(10, VOICE_PROVIDER_RETRY_CONFIG)).toBe(10_000);
    expect(VOICE_PROVIDER_RETRY_CONFIG.maxAttempts).toBeGreaterThan(DEFAULT_RETRY_CONFIG.maxAttempts);
  });

  it("readProviderRetryConfig defaults to the voice-provider profile but honors overrides", () => {
    expect(readProviderRetryConfig({})).toEqual(VOICE_PROVIDER_RETRY_CONFIG);
    expect(readProviderRetryConfig({ retry_max_delay_ms: 3000 }).maxDelayMs).toBe(3000);
    // The plain default profile is unchanged (intra-turn low-latency retries).
    expect(readRetryConfig({})).toEqual(DEFAULT_RETRY_CONFIG);
  });
});
