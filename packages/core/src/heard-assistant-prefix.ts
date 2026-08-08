// SPDX-License-Identifier: MIT
//
// Heard-assistant prefix — how much of an assistant reply the caller actually
// heard at barge-in time.

import type { TtsWordTimestamp } from "./packets.js";

/** Metric name emitted on Route.Background when the proportional estimate is used. */
export const HEARD_PREFIX_ESTIMATED_METRIC = "heard_prefix.estimated";

/**
 * English conversational speech ≈ 150 words/minute. Average English word length
 * is ~5 characters plus a space → ~6 chars/word → 150 × 6 / 60 ≈ 15 chars/s.
 */
export const HEARD_PREFIX_CHARS_PER_SECOND = 15;

export interface HeardAssistantPrefixResult {
  readonly heard: string;
  /** True when word timings were unavailable and playout time was estimated. */
  readonly usedEstimate: boolean;
}

/**
 * Compute the assistant text the caller actually heard at barge-in.
 *
 * **Exact path (word timings present):** only Cartesia emits `tts.word_timestamps`
 * today; words whose `endMs` ≤ reported playout are joined. All other TTS
 * providers rely on the estimate below.
 *
 * | provider | word timings |
 * | --- | --- |
 * | cartesia | yes |
 * | deepgram | no |
 * | openai-tts | no |
 * | gemini | no |
 * | elevenlabs | no |
 * | realtime fronts (Gemini Live audio) | no |
 * | tts-core, cli, test helpers | no |
 *
 * **Estimate path (no word timings):** never returns the full emitted text when
 * playout is partial. Characters heard ≈ `playedOutMs / 1000 × 15`, clamped to
 * `[0, emitted.length]`, then truncated at the last complete word boundary.
 * Returns empty when `playedOutMs` is 0 or undefined.
 */
export function computeHeardAssistantPrefix(params: {
  readonly emittedText: string;
  readonly playedOutMs: number | undefined;
  readonly wordTimestamps: readonly TtsWordTimestamp[] | undefined;
}): HeardAssistantPrefixResult {
  const emitted = params.emittedText.trim();
  const { playedOutMs, wordTimestamps: words } = params;

  if (words && words.length > 0 && playedOutMs !== undefined && playedOutMs > 0) {
    return {
      heard: words.filter((word) => word.endMs <= playedOutMs).map((word) => word.word).join(" "),
      usedEstimate: false,
    };
  }

  if (playedOutMs === undefined || playedOutMs <= 0 || emitted.length === 0) {
    return { heard: "", usedEstimate: true };
  }

  const estimatedChars = Math.min(
    emitted.length,
    Math.floor((playedOutMs / 1000) * HEARD_PREFIX_CHARS_PER_SECOND),
  );
  return {
    heard: truncateAtWordBoundary(emitted, estimatedChars),
    usedEstimate: true,
  };
}

/** Cut at the last complete word that fits within `maxChars`; never mid-word. */
export function truncateAtWordBoundary(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  const trimmed = text.trim();
  if (maxChars >= trimmed.length) return trimmed;

  let cut = maxChars;
  if (trimmed[cut] !== " " && trimmed[cut - 1] !== " ") {
    const lastSpace = trimmed.lastIndexOf(" ", cut - 1);
    cut = lastSpace === -1 ? 0 : lastSpace;
  }
  return trimmed.slice(0, cut).trim();
}
