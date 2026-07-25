// SPDX-License-Identifier: MIT
//
// Every case here folds a real SessionRecord via buildSessionRecord(...), the same
// idiom as Timeline.test.tsx. We never hand-roll a TurnRecord and never feed the panel
// raw messages — the record is the contract, and these tests pin the panel to it.

import { buildSessionRecord } from "@kuralle-syrinx/browser-client/record";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TranscriptPanel } from "./TranscriptPanel";

type Msg = Record<string, unknown>;
const rec = (msgs: readonly Msg[]): ReturnType<typeof buildSessionRecord> =>
  buildSessionRecord(msgs.map((m, i) => ({ message: m as never, atMs: i })));
const recAt = (pairs: readonly { readonly message: Msg; readonly atMs: number }[]): ReturnType<typeof buildSessionRecord> =>
  buildSessionRecord(pairs.map((p) => ({ message: p.message as never, atMs: p.atMs })));

describe("TranscriptPanel", () => {
  it("teaches what will appear before any turn exists", () => {
    render(<TranscriptPanel record={rec([])} />);
    expect(screen.getByTestId("transcript-panel")).toHaveTextContent(/connect and speak/i);
  });

  it("groups user and assistant turns by turnId", () => {
    const record = rec([
      { type: "stt_output", turnId: "t1", transcript: "Add Biology 101." },
      { type: "agent_chunk", turnId: "t1", text: "Done." },
      { type: "stt_output", turnId: "t2", transcript: "Thanks." },
      { type: "agent_chunk", turnId: "t2", text: "Anytime." },
    ]);
    render(<TranscriptPanel record={record} />);
    expect(screen.getAllByTestId("transcript-turn")).toHaveLength(2);
    expect(screen.getAllByTestId("transcript-user")).toHaveLength(2);
    expect(screen.getAllByTestId("transcript-assistant")).toHaveLength(2);
  });

  describe("interim → final", () => {
    it("renders interim user text visibly provisional (muted, italic)", () => {
      const record = rec([{ type: "stt_chunk", turnId: "t1", transcript: "hel" }]);
      render(<TranscriptPanel record={record} />);
      const bubble = screen.getByTestId("transcript-user-interim");
      expect(bubble).toHaveTextContent("hel");
      expect(bubble).toHaveClass("italic");
      expect(bubble).toHaveTextContent(/listening/i);
      // No confidence on an interim that has not resolved.
      expect(bubble).not.toHaveTextContent(/confident/i);
      // No finalized user bubble exists alongside it.
      expect(screen.queryByTestId("transcript-user")).not.toBeInTheDocument();
    });

    it("replaces the interim in place with the final and shows confidence", () => {
      const record = rec([
        { type: "stt_chunk", turnId: "t1", transcript: "hel" },
        { type: "stt_output", turnId: "t1", transcript: "Add Biology 101.", confidence: 0.92 },
      ]);
      render(<TranscriptPanel record={record} />);

      // Exactly one user bubble, and it is the finalized one — the interim did not
      // linger as a second bubble.
      expect(screen.queryByTestId("transcript-user-interim")).not.toBeInTheDocument();
      const bubble = screen.getByTestId("transcript-user");
      expect(bubble).toHaveTextContent("Add Biology 101.");
      expect(bubble).not.toHaveClass("italic");
      expect(bubble).toHaveTextContent("92% confident");
      // The provisional "hel" is gone, not stacked.
      expect(bubble).not.toHaveTextContent(/^hel$/);
    });
  });

  describe("barge-in", () => {
    it("renders the interruption inline with its reason and the elapsed time into the turn", () => {
      // The first message lands at atMs=0, so the turn's startedAtMs is 0; the
      // interruption at 1200 therefore reads as 1.20s — the responsiveness number.
      const record = recAt([
        { atMs: 0, message: { type: "agent_chunk", turnId: "t1", text: "Let me look " } },
        { atMs: 500, message: { type: "agent_chunk", turnId: "t1", text: "that up." } },
        { atMs: 1200, message: { type: "agent_interrupted", turnId: "t1", reason: "barge_in" } },
      ]);
      render(<TranscriptPanel record={record} />);

      const marker = screen.getByTestId("transcript-interruption");
      // Plain-language reason, never the raw `barge_in` packet name.
      expect(marker).toHaveTextContent(/you started speaking/i);
      expect(marker).not.toHaveTextContent("barge_in");
      // The elapsed time is shown and matches atMs - startedAtMs.
      expect(marker).toHaveTextContent("1.20s");
      expect(marker.getAttribute("data-turn")).toBe("t1");
    });

    it("computes elapsed time from the turn's actual start, not from zero", () => {
      // Turn starts at 3000ms into the record (after some earlier activity) and is
      // interrupted 700ms later. The marker must read 700ms, not 3.70s.
      const record = recAt([
        { atMs: 0, message: { type: "agent_chunk", turnId: "earlier", text: "prior turn" } },
        { atMs: 3000, message: { type: "agent_chunk", turnId: "t1", text: "speaking" } },
        { atMs: 3700, message: { type: "agent_interrupted", turnId: "t1", reason: "barge_in" } },
      ]);
      render(<TranscriptPanel record={record} />);
      const marker = screen.getByTestId("transcript-interruption");
      // The t1 interruption marker (not any other) is the one with data-turn="t1".
      expect(within(marker).getByText(/700ms/)).toBeInTheDocument();
      expect(marker).not.toHaveTextContent("3.70s");
    });
  });

  describe("tool cues", () => {
    const toolMsg = (phase: string, extra: Msg = {}): Msg => ({
      type: `tool_call_${phase}`,
      turnId: "t1",
      toolId: "x",
      toolName: "search_catalog",
      ...extra,
    });

    it("arms an indicator on `started`", () => {
      render(<TranscriptPanel record={rec([toolMsg("started")])} />);
      const tool = screen.getByTestId("transcript-tool");
      expect(tool.getAttribute("data-phase")).toBe("started");
      expect(tool).toHaveTextContent(/working/i);
      expect(tool).not.toHaveTextContent(/slow|done|failed/i);
    });

    it("escalates on `delayed` and shows the time it has been running", () => {
      render(<TranscriptPanel record={rec([toolMsg("delayed", { afterMs: 1500 })])} />);
      const tool = screen.getByTestId("transcript-tool");
      expect(tool.getAttribute("data-phase")).toBe("delayed");
      expect(tool).toHaveTextContent(/slow/i);
      expect(tool).toHaveTextContent("1.50s"); // the afterMs, formatted
    });

    it("clears the indicator on `complete`", () => {
      render(<TranscriptPanel record={rec([toolMsg("complete")])} />);
      const tool = screen.getByTestId("transcript-tool");
      expect(tool.getAttribute("data-phase")).toBe("complete");
      expect(tool).toHaveTextContent(/done/i);
      expect(tool).not.toHaveTextContent(/slow|failed/i);
    });

    it("renders `failed` visually distinct from `delayed` (not just a slow tool)", () => {
      const { rerender } = render(<TranscriptPanel record={rec([toolMsg("delayed", { afterMs: 1500 })])} />);
      const slow = screen.getByTestId("transcript-tool");
      expect(slow.getAttribute("data-phase")).toBe("delayed");
      // The badge is the amber "slow" cue.
      expect(slow.querySelector("span")!).toHaveClass("bg-amber-50");
      expect(slow).not.toHaveTextContent(/failed/i);

      rerender(<TranscriptPanel record={rec([toolMsg("failed")])} />);
      const failed = screen.getByTestId("transcript-tool");
      expect(failed.getAttribute("data-phase")).toBe("failed");
      expect(failed).toHaveTextContent(/failed/i);
      // A failed tool must read as an error (red), not a warning (amber).
      expect(failed.querySelector("span")!).toHaveClass("bg-red-50");
      expect(failed.querySelector("span")!).not.toHaveClass("bg-amber-50");
    });

    it("makes the tool name, arguments, and result inspectable inline", () => {
      // agent_tool_call carries args keyed by `id`; tool_call_complete carries the phase
      // keyed by `toolId`; agent_tool_result carries the result keyed by `id`. With a
      // matching id/toolId they fold into ONE tool on the record.
      const record = rec([
        { type: "agent_tool_call", turnId: "t1", id: "x", name: "search_catalog", args: { query: "biology" } },
        { type: "tool_call_complete", turnId: "t1", toolId: "x", toolName: "search_catalog" },
        { type: "agent_tool_result", turnId: "t1", id: "x", result: { hits: 3 } },
      ]);
      render(<TranscriptPanel record={record} />);

      const tool = screen.getByTestId("transcript-tool");
      expect(tool.getAttribute("data-tool-name")).toBe("search_catalog");
      expect(tool).toHaveTextContent("search_catalog");
      // Arguments are present and inspectable (collapsed <details>, but in the DOM).
      const args = screen.getByTestId("transcript-tool-args");
      expect(args).toHaveTextContent("query");
      expect(args).toHaveTextContent("biology");
      // Result is present and inspectable.
      const result = screen.getByTestId("transcript-tool-result");
      expect(result).toHaveTextContent("hits");
      expect(result).toHaveTextContent("3");
    });
  });
});
