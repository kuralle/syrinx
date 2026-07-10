// SPDX-License-Identifier: MIT

export interface ConfidenceToWaitConfig {
  /** Wait at confidence = 1.0 (high EOT certainty). Default: 150 ms. */
  readonly minWaitMs?: number;
  /** Wait at confidence = 0.0 (low EOT certainty). Default: 2000 ms. */
  readonly maxWaitMs?: number;
}

const DEFAULT_MIN_WAIT_MS = 150;
const DEFAULT_MAX_WAIT_MS = 2000;

/**
 * Maps an end-of-turn confidence score to a bounded finalize wait (LiveKit-style).
 * Higher confidence → shorter wait. Monotonic, clamped, deterministic.
 */
export function confidenceToWaitMs(
  confidence: number,
  config: ConfidenceToWaitConfig = {},
): number {
  const minWaitMs = config.minWaitMs ?? DEFAULT_MIN_WAIT_MS;
  const maxWaitMs = config.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  if (maxWaitMs < minWaitMs) {
    throw new Error(`maxWaitMs (${String(maxWaitMs)}) must be >= minWaitMs (${String(minWaitMs)})`);
  }

  const clamped = Math.min(1, Math.max(0, confidence));
  const span = maxWaitMs - minWaitMs;
  return Math.round(maxWaitMs - clamped * span);
}