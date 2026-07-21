// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { takeCompleteVoiceText, isCompleteVoiceText, appendVoiceText, normalizeForSpeech, stripLeakedToolCalls } from "./voice-text.js";

describe("stripLeakedToolCalls", () => {
  it("removes XML-style tool_call blocks including inner JSON", () => {
    expect(
      stripLeakedToolCalls('Sure. <tool_call>{"name":"lookup","arguments":{"id":"7"}}</tool_call>'),
    ).toBe("Sure.");
  });

  it("removes special sentinel tokens (Gemma/Llama/harmony) and Mistral markers", () => {
    expect(stripLeakedToolCalls("<|tool_call|> checking now")).toBe("checking now");
    expect(stripLeakedToolCalls("<|channel|>commentary answer")).toBe("answer");
    expect(stripLeakedToolCalls("[TOOL_CALLS] one moment")).toBe("one moment");
  });

  it("leaves real speech with legitimate punctuation untouched", () => {
    const prose = "The deadline is February 5th, and the fee is 40 dollars.";
    expect(stripLeakedToolCalls(prose)).toBe(prose);
  });

  it("does NOT strip bare JSON (ambiguous — that's a serving-stack bug, not ours to guess)", () => {
    const s = 'Your balance is {"amount": 42}.';
    expect(stripLeakedToolCalls(s)).toBe(s);
  });

  it("is applied inside normalizeForSpeech so leaked markup never reaches TTS", () => {
    expect(normalizeForSpeech("<tool_call>{}</tool_call>**Done.**")).toBe("Done.");
  });
});

describe("normalizeForSpeech", () => {
  it("strips bold, italic, strikethrough, and code markers", () => {
    expect(normalizeForSpeech("This is **bold** and *italic* and `code`.")).toBe(
      "This is bold and italic and code.",
    );
    expect(normalizeForSpeech("__strong__ and _em_ and ~~gone~~")).toBe("strong and em and gone");
  });

  it("reduces a markdown link to its label", () => {
    expect(normalizeForSpeech("See [the deadline](https://x.edu/deadline) today.")).toBe(
      "See the deadline today.",
    );
  });

  it("removes leading block markers: headings, bullets, quotes, numbered lists", () => {
    expect(normalizeForSpeech("## Deadlines")).toBe("Deadlines");
    expect(normalizeForSpeech("- upload the form")).toBe("upload the form");
    expect(normalizeForSpeech("1. first step")).toBe("first step");
    expect(normalizeForSpeech("> a quote")).toBe("a quote");
  });

  it("leaves ordinary prose untouched", () => {
    const prose = "Your late add deadline was February 5th, and the fee is 40 dollars.";
    expect(normalizeForSpeech(prose)).toBe(prose);
  });

  it("does not mangle a lone asterisk or hash inside prose", () => {
    // Conservative: an isolated * or # that isn't a paired/leading marker stays.
    expect(normalizeForSpeech("Use the * key or press # to continue.")).toBe(
      "Use the * key or press # to continue.",
    );
  });
});

describe("isCompleteVoiceText", () => {
  it("treats terminal punctuation as complete", () => {
    expect(isCompleteVoiceText("Hello there.")).toBe(true);
    expect(isCompleteVoiceText("Really?!")).toBe(true);
  });

  it("treats an unterminated fragment as incomplete", () => {
    expect(isCompleteVoiceText("Hello there")).toBe(false);
    expect(isCompleteVoiceText("and then we")).toBe(false);
  });

  it("looks past trailing closing quotes/brackets to the terminator", () => {
    expect(isCompleteVoiceText('She said "hi."')).toBe(true);
    expect(isCompleteVoiceText("(a complete aside.)")).toBe(true);
    expect(isCompleteVoiceText('an open quote "')).toBe(false);
  });

  it("recognizes non-English terminal punctuation", () => {
    expect(isCompleteVoiceText("こんにちは。")).toBe(true); // Japanese full stop
    expect(isCompleteVoiceText("مرحبا؟")).toBe(true); // Arabic question mark
    expect(isCompleteVoiceText("नमस्ते।")).toBe(true); // Devanagari danda
  });

  it("does not treat abbreviation or decimal dots as sentence ends", () => {
    // These would otherwise be voiced with a falling intonation and split from
    // their continuation ("Dr." | "Smith", "twelve." | "fifty").
    expect(isCompleteVoiceText("Dr.")).toBe(false);
    expect(isCompleteVoiceText("e.g.")).toBe(false);
    expect(isCompleteVoiceText("The total is $12.")).toBe(false);
    expect(isCompleteVoiceText("Meet at 3 p.m.")).toBe(false);
    expect(isCompleteVoiceText("His name is J.")).toBe(false);
    // But a real sentence end after an abbreviation earlier in the text is fine.
    expect(isCompleteVoiceText("Dr. Smith will see you now.")).toBe(true);
    expect(isCompleteVoiceText("The total is $12.50 today.")).toBe(true);
  });
});

describe("takeCompleteVoiceText", () => {
  it("splits leading complete sentences from the incomplete remainder", () => {
    const { text, remaining } = takeCompleteVoiceText("One. Two. Thre");
    expect(text).toBe("One. Two.");
    expect(remaining).toBe("Thre");
  });

  it("returns no text when nothing is complete yet", () => {
    const { text, remaining } = takeCompleteVoiceText("still going");
    expect(text).toBe("");
    expect(remaining).toBe("still going");
  });

  it("emits multiple complete sentences and buffers only the trailing fragment", () => {
    const { text, remaining } = takeCompleteVoiceText("Done. And more.");
    expect(text).toBe("Done. And more.");
    expect(remaining).toBe("");
  });

  it("buffers the trailing incomplete fragment after a complete sentence", () => {
    // Capitalized continuation so the locale-aware segmenter treats it as a new
    // (still-incomplete) sentence rather than one run-on.
    const { text, remaining } = takeCompleteVoiceText("Done. And more");
    expect(text).toBe("Done.");
    expect(remaining).toBe("And more");
  });
});

describe("appendVoiceText", () => {
  it("seeds from empty and trims", () => {
    expect(appendVoiceText("", "  hi  ")).toBe("hi");
  });

  it("joins with a single space when neither side has whitespace at the seam", () => {
    expect(appendVoiceText("Hello", "there")).toBe("Hello there");
  });

  it("does not double-space when the existing side already ends in whitespace", () => {
    expect(appendVoiceText("Hello ", "there")).toBe("Hello there");
  });

  it("trims a whitespace-led next fragment (the seam's space collapses)", () => {
    // Current behavior: a leading-whitespace `next` is trimmed and concatenated
    // directly. Reachable inputs (trimmed segment text) never hit this path; the
    // test pins the documented behavior rather than the intuitive one.
    expect(appendVoiceText("Hello", " there")).toBe("Hellothere");
  });

  it("returns the existing text unchanged when the next fragment is blank", () => {
    expect(appendVoiceText("Hello", "   ")).toBe("Hello");
  });
});
