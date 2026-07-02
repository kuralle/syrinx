// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Voice Text Segmentation
//
// Pure helpers for turning a streaming LLM token feed into complete, speakable
// sentence segments. No bus, no state — extracted from VoiceAgentSession so the
// orchestrator owns wiring, not text rules.

interface SentenceSegment {
  segment: string;
}

/**
 * Split off the leading run of complete sentences from `text`, returning the
 * speakable prefix and the still-incomplete remainder. A segment is "complete"
 * when it ends in terminal punctuation (optionally followed by closing quotes).
 */
export function takeCompleteVoiceText(text: string): { text: string; remaining: string } {
  const segments = segmentSentences(text);
  let emitted = "";
  let remaining = "";
  for (const segment of segments) {
    if (remaining) {
      remaining += segment;
      continue;
    }
    if (isCompleteVoiceText(segment)) {
      emitted += segment;
    } else {
      remaining = segment;
    }
  }
  return { text: emitted.trimEnd(), remaining };
}

// Common abbreviations whose trailing "." is not a sentence end. Lowercased,
// dots stripped, so "e.g." matches "eg". Kept small and English-centric — the
// turn-end flush handles anything that legitimately ends here.
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "eg", "ie",
  "am", "pm", "no", "vol", "inc", "ltd", "co", "gen", "gov", "sen", "rep",
  "apt", "dept", "approx", "est", "min", "max",
]);

/**
 * A segment ending in "." is not necessarily a finished sentence: it may be a
 * decimal point ("$12." before "50") or an abbreviation dot ("Dr." before a
 * name, "e.g."). Voicing those as sentence ends produces "twelve." (falling
 * intonation) … "fifty", or splits "Dr." from the name. Defer them — if nothing
 * follows, the turn-end flush still speaks the tail.
 */
function isFalseTerminalDot(endsWithDot: string): boolean {
  const beforeDot = endsWithDot.slice(0, -1);
  if (/\d$/.test(beforeDot)) return true; // decimal / ordinal: "12." , "$3."
  const word = beforeDot.match(/([A-Za-z][A-Za-z.]*)$/);
  if (!word) return false;
  const normalized = word[1]!.replace(/\./g, "").toLowerCase();
  if (ABBREVIATIONS.has(normalized)) return true;
  if (normalized.length === 1) return true; // single initial: "J."
  return false;
}

export function isCompleteVoiceText(text: string): boolean {
  const trimmed = text.trim();
  for (let index = trimmed.length - 1; index >= 0; index -= 1) {
    const char = trimmed[index]!;
    if (isClosingPunctuation(char)) continue;
    if (!isTerminalPunctuation(char)) return false;
    if (char === "." && isFalseTerminalDot(trimmed.slice(0, index + 1))) return false;
    return true;
  }
  return false;
}

/** Join two voice-text fragments, normalizing whitespace at the seam. */
export function appendVoiceText(existing: string, next: string): string {
  const normalizedNext = next.trim();
  if (!existing) return normalizedNext;
  if (!normalizedNext) return existing;
  if (/\s$/.test(existing) || /^\s/.test(next)) return `${existing}${normalizedNext}`;
  return `${existing} ${normalizedNext}`;
}

function isClosingPunctuation(char: string): boolean {
  return char === ")" || char === "]" || char === "}" || char === "\"" || char === "'" || char === "”" || char === "’";
}

function isTerminalPunctuation(char: string): boolean {
  return char === "." ||
    char === "!" ||
    char === "?" ||
    char === "。" ||
    char === "！" ||
    char === "？" ||
    char === "؟" ||
    char === "।" ||
    char === "॥";
}

// The ICU sentence segmenter is one of the more expensive Intl allocations;
// building one per LLM delta (50–200/turn) is avoidable CPU/GC churn on the
// token→TTS latency path. It is stateless, so cache one per process. `undefined`
// = not yet computed; `null` = unavailable (fall back to the regex splitter).
let cachedSegmenter: { segment(text: string): Iterable<SentenceSegment> } | null | undefined;

function getSentenceSegmenter(): { segment(text: string): Iterable<SentenceSegment> } | null {
  if (cachedSegmenter === undefined) cachedSegmenter = createSentenceSegmenter();
  return cachedSegmenter;
}

function segmentSentences(text: string): string[] {
  const segmenter = getSentenceSegmenter();
  if (segmenter) {
    return Array.from(segmenter.segment(text), (part) => part.segment);
  }

  const segments: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (!isTerminalPunctuation(text[index]!)) continue;
    let end = index + 1;
    while (end < text.length && isClosingPunctuation(text[end]!)) end += 1;
    if (end < text.length && !/\s/.test(text[end]!)) continue;
    segments.push(text.slice(start, end));
    start = end;
  }
  if (start < text.length) segments.push(text.slice(start));
  return segments;
}

function createSentenceSegmenter(): { segment(text: string): Iterable<SentenceSegment> } | null {
  const Segmenter = (Intl as unknown as { Segmenter?: new (
    locale?: string | string[],
    options?: { granularity: "sentence" },
  ) => { segment(text: string): Iterable<SentenceSegment> } }).Segmenter;
  if (!Segmenter) return null;
  try {
    return new Segmenter(undefined, { granularity: "sentence" });
  } catch {
    return null;
  }
}
