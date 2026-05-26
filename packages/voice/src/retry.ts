// SPDX-License-Identifier: MIT

export interface RetryConfig {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 2000,
};

export function readRetryConfig(config: Record<string, unknown>): RetryConfig {
  return {
    maxAttempts: readPositiveInteger(config["retry_max_attempts"], DEFAULT_RETRY_CONFIG.maxAttempts),
    baseDelayMs: readPositiveInteger(config["retry_base_delay_ms"], DEFAULT_RETRY_CONFIG.baseDelayMs),
    maxDelayMs: readPositiveInteger(config["retry_max_delay_ms"], DEFAULT_RETRY_CONFIG.maxDelayMs),
  };
}

export function retryDelayMs(attemptIndex: number, config: RetryConfig): number {
  const exponential = config.baseDelayMs * 2 ** Math.max(0, attemptIndex - 1);
  return Math.min(config.maxDelayMs, exponential);
}

export async function waitForRetryDelay(attemptIndex: number, config: RetryConfig, signal?: AbortSignal): Promise<void> {
  const delayMs = retryDelayMs(attemptIndex, config);
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    const timeout = setTimeout(resolve, delayMs);
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  const err = new Error("Retry aborted");
  err.name = "AbortError";
  return err;
}

function readPositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const integer = Math.floor(value);
  return integer > 0 ? integer : fallback;
}
