// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { takeCompleteVoiceText, isCompleteVoiceText, appendVoiceText } from "./voice-text.js";

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
