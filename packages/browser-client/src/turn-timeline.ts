// SPDX-License-Identifier: MIT
//
// Turn timeline — the per-turn latency waterfall, computed from the `metrics`
// message the server already sends.
//
// "It cut me off" is not actionable; a lane showing speech ending at 2.1s and the
// endpoint firing at 2.16s is. This is the view no competing playground ships,
// and the data has been arriving in the browser all along.
//
// Pure and DOM-free, so a timeline can be rendered from a recorded fixture in a
// test rather than only from a live provider.

import type { TurnRecord, TurnTimings } from "./session-record.js";

export interface TimelineSegment {
  readonly key: string;
  /** Plain language. The reader does not know what `eos.turn_complete` is. */
  readonly label: string;
  readonly startMs: number;
  readonly durationMs: number;
  /** True for the longest segment — where the time actually went. */
  readonly slowest: boolean;
}

export interface TurnTimeline {
  readonly turnId: string;
  readonly segments: readonly TimelineSegment[];
  readonly totalMs: number;
  /** Why there is nothing to draw, when there is nothing to draw. */
  readonly unavailable?: "no-metrics" | "insufficient-marks";
  /**
   * Set when the agent replied implausibly fast, which almost always means the
   * endpointer fired while the caller was still speaking. Most tools celebrate
   * this number; it is usually a defect.
   */
  readonly suspiciouslyFast?: { readonly totalMs: number; readonly floorMs: number };
}

/**
 * Below this, a reply is not "fast" — the endpointer almost certainly cut the
 * caller off. Asserting a floor as well as a ceiling is the inversion no
 * surveyed framework supports.
 */
export const FAST_TURN_FLOOR_MS = 700;

// Ordered marks. Each segment spans one mark to the next, so a missing mark
// collapses its segment rather than corrupting the ones around it.
const MARKS: readonly { readonly field: keyof TurnTimings; readonly label: string }[] = [
  { field: "speechEndMs", label: "You stopped speaking" },
  { field: "textReadyMs", label: "Deciding you're done, transcribing, and thinking" },
  // Segments are labelled by the mark that ENDS them, so this one covers
  // textReady -> firstAudioByte: the reply text already exists and we are waiting on
  // speech. That is time-to-first-audio, which `session-metrics` reports as
  // "Voice (to first audio)" from the same field. Calling it "Thinking" made the two
  // panels name one quantity two different things.
  { field: "firstAudioByteMs", label: "Voice (to first audio)" },
  { field: "firstAudioPlayedMs", label: "First audio out" },
  { field: "lastAudioPlayedMs", label: "Agent speaking" },
];

export function buildTurnTimeline(turn: TurnRecord): TurnTimeline {
  const t = turn.timings;
  if (!t) {
    // The Workers path emits no `metrics` at all (proven by LDT-18). Say so
    // rather than rendering an empty lane that looks like a zero-latency turn.
    return { turnId: turn.turnId, segments: [], totalMs: 0, unavailable: "no-metrics" };
  }

  const points = MARKS.map(({ field, label }) => ({ label, at: t[field] })).filter(
    (p): p is { label: string; at: number } => typeof p.at === "number",
  );

  if (points.length < 2) {
    return { turnId: turn.turnId, segments: [], totalMs: t.ttfaPlayedMs ?? t.ttfaMs ?? 0, unavailable: "insufficient-marks" };
  }

  const origin = points[0]?.at ?? 0;
  const raw = points.slice(1).map((p, i) => {
    const prev = points[i];
    const startMs = (prev?.at ?? origin) - origin;
    return { key: p.label, label: p.label, startMs, durationMs: Math.max(0, p.at - (prev?.at ?? origin)) };
  });

  const longest = raw.reduce((max, s) => Math.max(max, s.durationMs), 0);
  const segments: TimelineSegment[] = raw.map((s) => ({ ...s, slowest: longest > 0 && s.durationMs === longest }));

  const totalMs = t.ttfaPlayedMs ?? t.ttfaMs ?? (points[points.length - 1]?.at ?? origin) - origin;
  const suspiciouslyFast =
    totalMs > 0 && totalMs < FAST_TURN_FLOOR_MS ? { totalMs, floorMs: FAST_TURN_FLOOR_MS } : undefined;

  return { turnId: turn.turnId, segments, totalMs, ...(suspiciouslyFast ? { suspiciouslyFast } : {}) };
}

export function buildTimelines(turns: readonly TurnRecord[]): readonly TurnTimeline[] {
  return turns.map(buildTurnTimeline);
}

// -----------------------------------------------------------------------------
// Endpointing decision rendering
// -----------------------------------------------------------------------------
// The timeline can already show WHEN a turn ended; this names WHO decided and WHY.
// That turns "it cut me off" from a feeling into a named cause. Pure and DOM-free
// so it is testable from a fixture; the component layer just renders `text`.

export type EndpointingMarkerKind = "typed" | "endpoint" | "unknown";

export interface EndpointingMarker {
  readonly kind: EndpointingMarkerKind;
  /** Plain language — never a packet or message name (`eos.turn_complete`, raw `provider_stt`, …). */
  readonly text: string;
}

/**
 * Turn an endpointing decision into the words a person reads. Internal type
 * values (`provider_stt`, `smart_turn`, `timer`, `text`, `force_finalized`, …)
 * stay internal; this is the only place they cross into user-facing text.
 *
 * A genuinely unknown decision is returned as `kind: "unknown"` rather than
 * guessed — a debugging surface that fabricates a cause is worse than one that
 * says it does not know.
 */
export function endpointingMarker(owner?: string, reason?: string): EndpointingMarker {
  if (owner === "text") {
    return {
      kind: "typed",
      text: "You typed this turn — nothing transcribed you and nothing judged when you finished, so no endpointer ran.",
    };
  }
  const who =
    owner === "provider_stt"
      ? "The speech-to-text provider"
      : owner === "smart_turn"
        ? "The Smart Turn model"
        : owner === "timer"
          ? "A turn timer"
          : undefined;
  if (who === undefined) {
    return {
      kind: "unknown",
      text: "This backend did not report what ended the turn, so the cause is unknown.",
    };
  }
  const text =
    reason === "force_finalized"
      ? `${who} force-finalized the transcript after a timeout, not a natural end of speech.`
      : `${who} decided you had finished speaking.`;
  return { kind: "endpoint", text };
}
