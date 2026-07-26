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

/**
 * Normalize a speakable segment so TTS does not read formatting aloud.
 *
 * LLM output is full of markdown — `**bold**`, `## heading`, `` `code` ``, `[text](url)` —
 * and a TTS engine narrates the punctuation literally ("star star bold star star"). This is
 * the single highest-frequency voice bug class and has no app-layer fix, because the text is
 * generated inside the pipeline. Vapi ships a 14-step "voice formatting plan" on by default;
 * this is the locale-free core of it: markdown removal.
 *
 * Deliberately conservative — it strips *formatting* markers, never content, so a sentence
 * that legitimately contains an asterisk or a hash in prose is left intact where ambiguous.
 * Number/currency/date verbalization is locale-sensitive and intentionally NOT done here yet;
 * doing it wrong (wrong locale, wrong magnitude) speaks worse than leaving the digits. That is
 * a separate stage, not a silent omission.
 */
/**
 * Strip leaked tool-call protocol tokens so TTS never speaks them.
 *
 * A model emits tool calls in its own syntax (`<|tool_call|>…`, `<tool_call>…</tool_call>`,
 * `[TOOL_CALLS]`, harmony `<|channel|>commentary`). The inference server is supposed to parse
 * that into the structured `tool_calls` field; when the serving stack lacks the right parser
 * the tokens fall through as ordinary assistant text and the pipeline speaks the markup aloud.
 * LiveKit's finding: the same weights score 100% behind one endpoint and 0% behind another —
 * it is the serving stack, not the model. Syrinx (and the Kuralle runtime) both read only the
 * finalized structured tool-call and never text-scrape, so neither catches a leaked one.
 *
 * This is a high-precision guard: it removes only unambiguous sentinel tokens/blocks that never
 * occur in real speech. It does NOT try to strip bare JSON function calls — that is ambiguous and
 * stripping legitimate content is worse than the rare leak. A leak of that shape is a serving-stack
 * bug to fix at the endpoint (LiveKit's "one curl" diagnosis), not something to paper over here.
 */
export function stripLeakedToolCalls(text: string): string {
  let out = text;
  // Paired XML-style blocks (Qwen/Hermes/Mistral): drop the whole block including inner JSON.
  out = out.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "");
  out = out.replace(/<tool_response>[\s\S]*?<\/tool_response>/gi, "");
  // Harmony: a channel token is immediately followed by its label (analysis/commentary/final).
  // Match the label only right after the token so a legitimate "commentary" in prose is untouched.
  out = out.replace(/<\|channel\|>\s*(?:analysis|commentary|final)\b/gi, "");
  // Special sentinel tokens (Gemma/Llama/harmony): <|...|> never appears in spoken text.
  out = out.replace(/<\|[^|]*\|>/g, "");
  // Mistral marker.
  out = out.replace(/\[TOOL_CALLS\]/gi, "");
  return out.replace(/[ \t]{2,}/g, " ").trim();
}

export function normalizeForSpeech(text: string): string {
  let out = stripLeakedToolCalls(text);
  // Links/images: [label](url) -> label ; ![alt](url) -> alt
  out = out.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Bold/italic/strikethrough: **x** __x__ *x* _x_ ~~x~~ -> x
  out = out.replace(/(\*\*|__)(.+?)\1/g, "$2");
  out = out.replace(/(\*|_)(?=\S)(.+?)(?<=\S)\1/g, "$2");
  out = out.replace(/~~(.+?)~~/g, "$1");
  // Inline + fenced code: `x` and ```x``` -> x
  out = out.replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/g, "$1");
  out = out.replace(/`([^`]+)`/g, "$1");
  // Leading block markers per line: headings (#), blockquotes (>), list bullets (-,*,+), numbered lists.
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  out = out.replace(/^\s{0,3}>\s?/gm, "");
  out = out.replace(/^\s{0,3}[-*+]\s+/gm, "");
  out = out.replace(/^\s{0,3}\d+\.\s+/gm, "");
  // Horizontal rules on their own line.
  out = out.replace(/^\s{0,3}([-*_])\1{2,}\s*$/gm, "");
  // Collapse whitespace the stripping may have opened up, preserving single spaces.
  out = out.replace(/[ \t]{2,}/g, " ");
  return out;
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

/**
 * The FIRST spoken fragment of a turn, taken earlier than a full sentence.
 *
 * Only the first dispatch gates time-to-first-audio: every later sentence is
 * synthesised while earlier audio is already playing, so its buffering is free.
 * But the sentence rule charges the first chunk the full wait for a terminator —
 * measured at ~200ms of a ~950ms TTFA.
 *
 * This takes a leading fragment at a CLAUSE boundary (comma, semicolon, colon,
 * dash) once it is long enough to be worth speaking. Never mid-word: the split is
 * always at punctuation followed by whitespace.
 *
 * Deliberately conservative about the cases `isCompleteVoiceText` guards — it will
 * not split on a decimal point or an abbreviation dot, because those are not
 * clause boundaries and never match here.
 *
 * Returns empty when no safe early split exists, in which case the caller keeps
 * waiting for a full sentence.
 */
export function takeFirstFragment(text: string, minChars: number): { text: string; remaining: string } {
  if (text.length < minChars) return { text: "", remaining: text };
  // Scan for a clause boundary at or after minChars so the fragment is substantial
  // enough to carry prosody on its own.
  for (let i = minChars - 1; i < text.length - 1; i += 1) {
    const ch = text[i];
    if (ch !== "," && ch !== ";" && ch !== ":" && ch !== "—") continue;
    const next = text[i + 1];
    if (next !== " " && next !== "\n") continue;
    return { text: text.slice(0, i + 1).trimEnd(), remaining: text.slice(i + 1) };
  }
  return { text: "", remaining: text };
}
