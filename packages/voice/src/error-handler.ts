// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Error Handler
//
// Categorizes errors from external service providers and determines
// whether they are recoverable (retry with backoff) or fatal (terminate session).
//
// Each component (STT, TTS, LLM) has its own categorization logic.
// The session manager uses these to decide retry vs. terminate.

import { ErrorCategory, type VoiceErrorPacket } from "./packets.js";

// =============================================================================
// Error Categorization
// =============================================================================

/**
 * Categorize an error from the STT provider.
 *
 * Heuristic:
 *   - HTTP 429 → RateLimit (recoverable)
 *   - Network errors (ECONNRESET, ETIMEDOUT, ENOTFOUND) → NetworkTimeout (recoverable)
 *   - HTTP 401/403 → Authentication (fatal)
 *   - HTTP 400/422 → InvalidInput (fatal)
 *   - HTTP 402 → ResourceExhausted (fatal)
 *   - Everything else → InternalFault (fatal)
 */
export function categorizeSttError(err: unknown): ErrorCategory {
  const msg = extractMessage(err).toLowerCase();
  const code = extractHttpStatus(err);

  if (code === 429 || msg.includes("rate limit") || msg.includes("too many requests")) {
    return ErrorCategory.RateLimit;
  }
  if (code === 401 || code === 403 || msg.includes("unauthorized") || msg.includes("forbidden")) {
    return ErrorCategory.Authentication;
  }
  if (code === 400 || code === 422 || msg.includes("invalid") || msg.includes("bad request")) {
    return ErrorCategory.InvalidInput;
  }
  if (msg.includes("data-000")) {
    return ErrorCategory.InvalidInput;
  }
  if (code === 402 || msg.includes("payment required") || msg.includes("insufficient")) {
    return ErrorCategory.ResourceExhausted;
  }
  if (
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("enotfound") ||
    msg.includes("network") ||
    msg.includes("net-000") ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("econnrefused") ||
    msg.includes("socket hang up") ||
    msg.includes("code=1011") ||
    msg.includes("internal error has occurred") ||
    (code !== null && code >= 500 && code <= 599)
  ) {
    return ErrorCategory.NetworkTimeout;
  }

  return ErrorCategory.InternalFault;
}

/**
 * Categorize an error from the TTS provider.
 * Same heuristic as STT — TTS providers have similar error patterns.
 */
export function categorizeTtsError(err: unknown): ErrorCategory {
  return categorizeSttError(err); // Same logic applies
}

/**
 * Categorize an error from the LLM provider.
 *
 * Additional LLM-specific heuristics:
 *   - "context length exceeded" → InvalidInput (fatal)
 *   - "content filter" / "safety" → InvalidInput (fatal)
 */
export function categorizeLlmError(err: unknown): ErrorCategory {
  const msg = extractMessage(err).toLowerCase();

  if (msg.includes("context length") || msg.includes("token limit") || msg.includes("too many tokens")) {
    return ErrorCategory.InvalidInput;
  }
  if (msg.includes("content filter") || msg.includes("safety") || msg.includes("blocked")) {
    return ErrorCategory.InvalidInput;
  }
  if (msg.includes("malformed_function_call")) {
    return ErrorCategory.NetworkTimeout;
  }

  return categorizeSttError(err); // Base logic for HTTP errors
}

// =============================================================================
// Recoverability
// =============================================================================

/**
 * Returns true if the error category is recoverable (retry with backoff).
 */
export function isRecoverable(category: ErrorCategory): boolean {
  return category === ErrorCategory.RateLimit || category === ErrorCategory.NetworkTimeout;
}

/**
 * Returns true if the error packet represents a fatal error.
 */
export function isFatalError(pkt: VoiceErrorPacket): boolean {
  return !pkt.isRecoverable;
}

// =============================================================================
// Helpers
// =============================================================================

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

function extractHttpStatus(err: unknown): number | null {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e.status === "number") return e.status;
    if (typeof e.statusCode === "number") return e.statusCode;
    if (typeof e.code === "number") return e.code;
  }
  return null;
}
