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

/**
 * Retry profile for long-lived voice-provider WebSockets (STT/TTS).
 *
 * Keeps the SAME fast first reconnect as the default (~125-250 ms) so a transient
 * blip during a live call recovers without dead air, but raises the backoff cap to
 * 10 s and allows more attempts so a persistent provider failure (rate limit /
 * outage) is retried patiently instead of giving up after ~2 s. This intentionally
 * does NOT use a multi-second *floor* (a 4 s first-retry would mean seconds of dead
 * air on a live call); "every 10 ms matters" applies to the first reconnect, patient
 * backoff applies only after repeated failures.
 */
export const VOICE_PROVIDER_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 6,
  baseDelayMs: 250,
  maxDelayMs: 10_000,
};

export const VOICE_PROVIDER_OUTAGE_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 4,
  baseDelayMs: 4_000,
  maxDelayMs: 10_000,
};

export function readRetryConfig(config: Record<string, unknown>): RetryConfig {
  return readRetryConfigWithDefaults(config, DEFAULT_RETRY_CONFIG);
}

/** Read retry config for a voice-provider WebSocket; defaults to the patient-backoff profile. */
export function readProviderRetryConfig(config: Record<string, unknown>): RetryConfig {
  const profile = typeof config["retry_profile"] === "string" ? config["retry_profile"] : "";
  return readRetryConfigWithDefaults(
    config,
    profile === "provider_outage" ? VOICE_PROVIDER_OUTAGE_RETRY_CONFIG : VOICE_PROVIDER_RETRY_CONFIG,
  );
}

function readRetryConfigWithDefaults(config: Record<string, unknown>, defaults: RetryConfig): RetryConfig {
  return {
    maxAttempts: readPositiveInteger(config["retry_max_attempts"], defaults.maxAttempts),
    baseDelayMs: readPositiveInteger(config["retry_base_delay_ms"], defaults.baseDelayMs),
    maxDelayMs: readPositiveInteger(config["retry_max_delay_ms"], defaults.maxDelayMs),
  };
}

export function retryDelayMs(attemptIndex: number, config: RetryConfig): number {
  const exponential = config.baseDelayMs * 2 ** Math.max(0, attemptIndex - 1);
  return Math.min(config.maxDelayMs, exponential);
}

/**
 * Equal-jitter backoff: half the deterministic exponential delay plus a random half.
 * Spreads out retries so many sessions hitting the same provider rate/concurrency limit
 * at once don't reconnect in lockstep (thundering herd). `rng` is injectable for tests.
 */
export function retryDelayWithJitterMs(
  attemptIndex: number,
  config: RetryConfig,
  rng: () => number = Math.random,
): number {
  const base = retryDelayMs(attemptIndex, config);
  const half = base / 2;
  return Math.round(half + rng() * half);
}

export async function waitForRetryDelay(attemptIndex: number, config: RetryConfig, signal?: AbortSignal): Promise<void> {
  const delayMs = retryDelayWithJitterMs(attemptIndex, config);
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
