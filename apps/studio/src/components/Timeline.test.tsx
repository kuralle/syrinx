import { buildSessionRecord } from "@kuralle-syrinx/browser-client/record";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Timeline } from "./Timeline";

const recordFrom = (msgs: readonly unknown[]) =>
  buildSessionRecord(msgs.map((m, i) => ({ message: m as never, atMs: i })));

describe("Timeline", () => {
  it("teaches what will appear before any turn exists", () => {
    render(<Timeline record={recordFrom([])} />);
    expect(screen.getByTestId("timeline-empty")).toHaveTextContent(/speak, or send a text turn/i);
  });

  it("renders one lane per turn from a recorded session", () => {
    const record = recordFrom([
      { type: "metrics", turnId: "t1", speechEndMs: 0, textReadyMs: 300, firstAudioByteMs: 1500, e2eMs: 2000 },
      { type: "metrics", turnId: "t2", speechEndMs: 0, textReadyMs: 200, firstAudioByteMs: 900, e2eMs: 1200 },
    ]);
    render(<Timeline record={record} />);
    expect(screen.getAllByTestId("timeline-lane")).toHaveLength(2);
  });

  it("labels segments in plain language", () => {
    const record = recordFrom([
      { type: "metrics", turnId: "t1", speechEndMs: 0, textReadyMs: 300, firstAudioByteMs: 1500, e2eMs: 2000 },
    ]);
    render(<Timeline record={record} />);
    expect(screen.getByTitle(/deciding you're done/i)).toBeInTheDocument();
    expect(screen.getByTitle(/thinking/i)).toBeInTheDocument();
  });

  it("warns on an implausibly fast turn instead of showing it as good", () => {
    const record = recordFrom([
      { type: "metrics", turnId: "t1", speechEndMs: 0, textReadyMs: 60, firstAudioByteMs: 400, e2eMs: 480 },
    ]);
    render(<Timeline record={record} />);
    expect(screen.getByTestId("fast-turn-warning")).toHaveTextContent(/below the .* floor/i);
    expect(screen.getByTestId("fast-turn-warning")).toHaveTextContent(/still speaking/i);
  });

  it("says so when the backend sends no timings, rather than drawing an empty lane", () => {
    // A blank bar would read as a zero-latency turn — the opposite of the truth.
    const record = recordFrom([{ type: "agent_chunk", turnId: "t1", text: "hi" }]);
    render(<Timeline record={record} />);
    expect(screen.getByText(/does not send per-turn timings/i)).toBeInTheDocument();
    expect(screen.queryByTestId("fast-turn-warning")).not.toBeInTheDocument();
  });

  it("shows a turn with timings alongside one without", () => {
    const record = recordFrom([
      { type: "metrics", turnId: "t1", speechEndMs: 0, textReadyMs: 300, firstAudioByteMs: 1500, e2eMs: 2000 },
      { type: "agent_chunk", turnId: "t2", text: "no metrics here" },
    ]);
    render(<Timeline record={record} />);
    expect(screen.getAllByTestId("timeline-lane")).toHaveLength(2);
    expect(screen.getByText(/does not send per-turn timings/i)).toBeInTheDocument();
  });
});
