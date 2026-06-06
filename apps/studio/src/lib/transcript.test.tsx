import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TranscriptPanel } from "@/components/TranscriptPanel";
import {
  initialTranscriptState,
  reduceTranscriptState,
  transcriptLines,
} from "@/lib/transcript";

describe("reduceTranscriptState", () => {
  it("accumulates user interim, final, and assistant streaming text", () => {
    let state = initialTranscriptState;

    state = reduceTranscriptState(state, {
      type: "stt_chunk",
      turnId: "turn-1",
      transcript: "hello maya",
    });
    expect(state.interimUser).toBe("hello maya");

    state = reduceTranscriptState(state, {
      type: "stt_output",
      turnId: "turn-1",
      transcript: "Hello Maya Chen here.",
    });
    expect(state.interimUser).toBeUndefined();
    expect(state.entries.at(-1)).toMatchObject({
      role: "user",
      text: "Hello Maya Chen here.",
    });

    state = reduceTranscriptState(state, {
      type: "agent_chunk",
      turnId: "turn-1",
      text: "You can submit ",
    });
    state = reduceTranscriptState(state, {
      type: "agent_chunk",
      turnId: "turn-1",
      text: "the Late Add Petition.",
    });
    expect(state.streamingAssistant?.text).toBe("You can submit the Late Add Petition.");

    state = reduceTranscriptState(state, {
      type: "agent_end",
      turnId: "turn-1",
    });
    expect(state.streamingAssistant).toBeUndefined();
    expect(state.entries.at(-1)).toMatchObject({
      role: "assistant",
      text: "You can submit the Late Add Petition.",
    });
  });
});

describe("TranscriptPanel", () => {
  it("renders live transcript lines from mock events", () => {
    const messages = [
      { type: "stt_chunk" as const, turnId: "t1", transcript: "partial" },
      { type: "stt_output" as const, turnId: "t1", transcript: "Can I add Biology 101?" },
      { type: "agent_chunk" as const, turnId: "t1", text: "Submit the Late Add Petition." },
      { type: "agent_end" as const, turnId: "t1" },
    ];

    const state = messages.reduce(reduceTranscriptState, initialTranscriptState);
    expect(transcriptLines(state)).toHaveLength(2);

    render(<TranscriptPanel state={state} />);

    expect(screen.getByText("Can I add Biology 101?")).toBeInTheDocument();
    expect(screen.getByText("Submit the Late Add Petition.")).toBeInTheDocument();
    expect(screen.getByTestId("transcript-user")).toBeInTheDocument();
    expect(screen.getByTestId("transcript-assistant")).toBeInTheDocument();
  });
});
