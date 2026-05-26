// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from "vitest";

import { readRetryConfig, retryDelayMs, waitForRetryDelay } from "./retry.js";

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
});
