import { buildSessionRecord } from "@kuralle-syrinx/browser-client/record";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { EventLog } from "./EventLog";

const recordFrom = (msgs: readonly unknown[]) =>
  buildSessionRecord(msgs.map((m, i) => ({ message: m as never, atMs: i })));

const chunks = (turnId: string, n: number) =>
  Array.from({ length: n }, () => ({ type: "tts_chunk", turnId, byteLength: 640 }));

describe("EventLog", () => {
  it("teaches what will appear before anything is on the wire", () => {
    render(<EventLog record={recordFrom([])} />);
    expect(screen.getByTestId("event-log-empty")).toHaveTextContent(/connect and speak/i);
    expect(screen.getByTestId("event-log-empty")).toHaveTextContent(/payload one click away/i);
  });

  it("streams every event newest first", () => {
    const record = recordFrom([
      { type: "ready", sessionId: "s1" },
      { type: "stt_output", turnId: "t1", transcript: "hello" },
      { type: "turn_complete", turnId: "t1" },
    ]);
    render(<EventLog record={record} />);
    const rows = screen.getAllByTestId("event-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveAttribute("data-type", "turn_complete");
    expect(rows[2]).toHaveAttribute("data-type", "ready");
  });

  it("renders a message type it has never heard of", () => {
    // The agents SDK sends these before `ready`; they are outside SyrinxStudioMessage.
    const record = recordFrom([
      { type: "cf_agent_identity", id: "abc" },
      { type: "cf_agent_mcp_servers", servers: [] },
    ]);
    render(<EventLog record={record} />);
    expect(screen.getAllByTestId("event-row")).toHaveLength(2);
    expect(screen.getByText("cf_agent_identity")).toBeInTheDocument();
  });

  it("hides per-frame noise behind a count, and reveals it on request", () => {
    const record = recordFrom([
      { type: "stt_output", turnId: "t1", transcript: "hi" },
      ...chunks("t1", 142),
      { type: "stt_chunk", turnId: "t1", transcript: "h" },
    ]);
    render(<EventLog record={record} />);

    expect(screen.getAllByTestId("event-row")).toHaveLength(1);
    expect(screen.getByTestId("per-frame-count")).toHaveTextContent(
      "142 audio frames, 1 partial transcripts hidden",
    );

    fireEvent.click(screen.getByTestId("per-frame-toggle"));
    expect(screen.getAllByTestId("event-row")).toHaveLength(144);
    expect(screen.getByTestId("per-frame-count")).toHaveTextContent(/shown$/);
  });

  it("keeps the count line free of packet names", () => {
    render(<EventLog record={recordFrom(chunks("t1", 3))} />);
    expect(screen.getByTestId("per-frame-count")).not.toHaveTextContent(/tts_chunk/);
  });

  it("filters to one turn", () => {
    const record = recordFrom([
      { type: "ready", sessionId: "s1" },
      // agent_chunk is suppressed by default (per-frame), so use turn-level
      // messages here — this test is about the turn filter, not suppression.
      { type: "agent_end", turnId: "t1" },
      { type: "agent_end", turnId: "t2" },
    ]);
    render(<EventLog record={record} />);

    fireEvent.change(screen.getByLabelText("Filter by turn"), { target: { value: "t2" } });
    const rows = screen.getAllByTestId("event-row");
    expect(rows).toHaveLength(1);
    expect(screen.getByTestId("event-turn")).toHaveTextContent("turn t2");

    fireEvent.change(screen.getByLabelText("Filter by turn"), { target: { value: "__session__" } });
    expect(screen.getAllByTestId("event-row")[0]).toHaveAttribute("data-type", "ready");
  });

  it("filters to one type, and asking for a per-frame type overrides the default hide", () => {
    const record = recordFrom([
      { type: "agent_chunk", turnId: "t1", text: "hi" },
      ...chunks("t1", 4),
    ]);
    render(<EventLog record={record} />);

    fireEvent.change(screen.getByLabelText("Filter by message type"), {
      target: { value: "tts_chunk" },
    });
    expect(screen.getAllByTestId("event-row")).toHaveLength(4);
  });

  it("expands one event's payload as JSON", () => {
    const record = recordFrom([{ type: "stt_output", turnId: "t1", transcript: "hello there" }]);
    render(<EventLog record={record} />);

    expect(screen.queryByTestId("event-payload")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByTestId("event-payload")).toHaveTextContent(/"transcript": "hello there"/);
  });

  it("copies the selected turn as JSON", () => {
    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    const record = recordFrom([
      { type: "ready", sessionId: "s1", audio: { inputSampleRateHz: 16000 } },
      { type: "agent_end", turnId: "t1" },
      { type: "agent_end", turnId: "t2" },
    ]);
    render(<EventLog record={record} />);

    expect(screen.getByTestId("copy-turn")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Filter by turn"), { target: { value: "t2" } });
    fireEvent.click(screen.getByTestId("copy-turn"));

    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = JSON.parse(writeText.mock.calls[0]![0]);
    expect(copied.turn.turnId).toBe("t2");
    // The negotiated config ships with the turn. Without it a pasted turn is
    // silently misleading — you cannot tell what sample rate or endpointing
    // owner produced it.
    expect(copied.config.sessionId).toBe("s1");
    expect(copied.config.inputSampleRateHz).toBe(16000);
    expect(screen.getByTestId("copy-turn")).toHaveTextContent("Copied turn t2");
  });

  it("keeps the type filter across a reconnect, and drops the stale turn filter", () => {
    // A reconnect replaces the record wholesale; turnIds are session-scoped, so
    // holding one would filter the new session down to nothing forever.
    const first = recordFrom([
      { type: "stt_output", turnId: "t1", transcript: "hi" },
      { type: "agent_chunk", turnId: "t1", text: "hello" },
    ]);
    const { rerender } = render(<EventLog record={first} />);

    fireEvent.change(screen.getByLabelText("Filter by message type"), {
      target: { value: "stt_output" },
    });
    fireEvent.change(screen.getByLabelText("Filter by turn"), { target: { value: "t1" } });
    expect(screen.getAllByTestId("event-row")).toHaveLength(1);

    rerender(<EventLog record={recordFrom([{ type: "agent_chunk", turnId: "t9", text: "new" }])} />);

    expect(screen.getByLabelText("Filter by message type")).toHaveValue("stt_output");
    expect(screen.getByLabelText("Filter by turn")).toHaveValue("__all__");
    expect(screen.getByTestId("event-log-no-match")).toBeInTheDocument();
  });

  it("surfaces dropped entries rather than silently truncating", () => {
    const record = buildSessionRecord(
      Array.from({ length: 6 }, (_, i) => ({
        message: { type: "agent_chunk", turnId: "t1", text: "x" } as never,
        atMs: i,
      })),
      {},
      { maxTurns: 50, maxEventsPerTurn: 4 },
    );
    render(<EventLog record={record} />);
    expect(screen.getByTestId("event-log-dropped")).toHaveTextContent(/2 events/);
  });
});

// --- Regressions from the LDT-6 review. Each of these three would have passed
// --- silently before; each is a way the panel misinformed the reader.

describe("EventLog — review regressions", () => {
  it("suppresses agent_chunk, the second-largest noise source", () => {
    // One message per LLM delta (server-websocket:513). Was not suppressed.
    const record = buildSessionRecord(
      Array.from({ length: 30 }, (_, i) => ({
        message: { type: "agent_chunk", turnId: "t1", text: "x" } as never,
        atMs: i,
      })),
    );
    render(<EventLog record={record} />);
    expect(screen.getByTestId("per-frame-count")).toHaveTextContent(/reply tokens/i);
  });

  it("does not list types that can never reach the record", () => {
    // ping and playout_progress are client→server only (browser-client:477, :514).
    const record = buildSessionRecord([
      { message: { type: "agent_end", turnId: "t1" } as never, atMs: 0 },
    ]);
    render(<EventLog record={record} />);
    expect(screen.queryByText(/keepalives|playback ticks/i)).not.toBeInTheDocument();
  });

  it("says entries are suppressed, not that nothing matched", () => {
    // Previously showed "142 audio frames hidden" AND "No entries match" together,
    // which sends the reader hunting for a filter bug that does not exist.
    const record = buildSessionRecord(
      Array.from({ length: 5 }, (_, i) => ({
        message: { type: "tts_chunk", turnId: "t1", byteLength: 10 } as never,
        atMs: i,
      })),
    );
    render(<EventLog record={record} />);
    expect(screen.getByTestId("event-log-all-suppressed")).toBeInTheDocument();
    expect(screen.queryByTestId("event-log-no-match")).not.toBeInTheDocument();
  });
});
