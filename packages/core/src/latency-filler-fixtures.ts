// SPDX-License-Identifier: MIT
//
// Labeled utterances for latency-filler connective selection tests.

export interface LatencyFillerFixture {
  readonly id: string;
  readonly userText: string;
  readonly expectedConnective: string;
}

export const LATENCY_FILLER_FIXTURES: readonly LatencyFillerFixture[] = [
  { id: "question", userText: "Can I still add Biology 101?", expectedConnective: "Well," },
  { id: "thanks", userText: "Thanks for checking that.", expectedConnective: "Right," },
  { id: "statement-0", userText: "I need the late add form.", expectedConnective: "So," },
  { id: "statement-1", userText: "My hold is blocking registration.", expectedConnective: "Well," },
] as const;
