// SPDX-License-Identifier: MIT
//
// A turn's user transcript is everything the user said in that turn.
//
// The STT provider emits one final per endpointed segment, so a long utterance
// arrives as several finals under one contextId. The turn transcript must be
// their concatenation. Keeping only the last one silently truncates the turn --
// observed live as a two-sentence utterance recorded as the single word
// "payment."

import { describe, expect, it } from "vitest";
import { TurnSegmentation } from "./iu-segmentation.js";

function userTextOf(seg: TurnSegmentation, contextId: string): string {
  return seg
    .committedTranscript(contextId)
    .filter((m) => m.role === "user")
    .map((m) => m.text)
    .join(" ");
}

describe("user transcript accumulation across STT finals", () => {
  it("keeps every final in a turn, not only the last", () => {
    const seg = new TurnSegmentation(() => {});
    const ctx = "ctx-two-finals";
    seg.beginTurn(ctx);

    // One utterance, endpointed by the provider into two finals. Each final
    // arrives the way VoiceAgentSession delivers it:
    // onSttPartial -> onSttResult -> recordUserTranscript(finalText).
    seg.onSttPartial(ctx);
    seg.onSttResult(ctx);
    seg.recordUserTranscript(ctx, "Does Biology 101 have a separate lab fee");

    seg.onSttPartial(ctx);
    seg.onSttResult(ctx);
    seg.recordUserTranscript(ctx, "because that changes how I plan my payment.");

    const text = userTextOf(seg, ctx);
    expect(text).toContain("lab fee");
    expect(text).toContain("payment");
  });

  it("still replaces interim text rather than accumulating it", () => {
    const seg = new TurnSegmentation(() => {});
    const ctx = "ctx-interims";
    seg.beginTurn(ctx);

    // Interims are successive revisions of the same hypothesis, not new content.
    seg.onSttPartial(ctx);
    seg.recordUserTranscript(ctx, "Does Biology");
    seg.onSttPartial(ctx);
    seg.recordUserTranscript(ctx, "Does Biology 101 have a lab fee");
    seg.onSttResult(ctx);

    expect(userTextOf(seg, ctx)).toBe("Does Biology 101 have a lab fee");
  });

  // VoiceAgentSession.handleSttResult calls onSttPartial -> onSttResult ->
  // recordUserTranscript(finalText), so the interim is committed before the
  // final text arrives. A final that refines its own interim must replace it,
  // not append to it.
  it("does not duplicate an interim when its final refines it, in session call order", () => {
    const seg = new TurnSegmentation(() => {});
    const ctx = "ctx-session-order";
    seg.beginTurn(ctx);

    // handleSttInterim
    seg.onSttPartial(ctx);
    seg.recordUserTranscript(ctx, "Does Biology 101 have a lab");

    // handleSttResult, in its real order
    seg.onSttPartial(ctx);
    seg.onSttResult(ctx);
    seg.recordUserTranscript(ctx, "Does Biology 101 have a separate lab fee");

    expect(userTextOf(seg, ctx)).toBe("Does Biology 101 have a separate lab fee");
  });

  it("does not bleed accumulated text into the next turn", () => {
    const seg = new TurnSegmentation(() => {});
    const ctx = "ctx-turn-boundary";
    seg.beginTurn(ctx);

    seg.onSttPartial(ctx);
    seg.recordUserTranscript(ctx, "first turn unique phrase");
    seg.onSttResult(ctx);

    seg.beginTurn(ctx);
    seg.onSttPartial(ctx);
    seg.recordUserTranscript(ctx, "second turn only");
    seg.onSttResult(ctx);

    const latest = seg
      .committedTranscript(ctx)
      .filter((m) => m.role === "user")
      .at(-1);
    expect(latest?.text).toBe("second turn only");
    expect(latest?.text).not.toContain("first turn unique phrase");
  });
});
