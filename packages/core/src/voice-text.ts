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

export function isCompleteVoiceText(text: string): boolean {
  const trimmed = text.trim();
  for (let index = trimmed.length - 1; index >= 0; index -= 1) {
    const char = trimmed[index]!;
    if (isClosingPunctuation(char)) continue;
    return isTerminalPunctuation(char);
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

function segmentSentences(text: string): string[] {
  const segmenter = createSentenceSegmenter();
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
