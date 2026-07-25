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

  it("charts a typed turn's real voice timings and names what it skipped", () => {
    // Captured live against dev:server: a typed turn omits speechEnd/stt/e2e (never
    // measured) and carries genuine audio marks, because the reply really is spoken.
    const record = recordFrom([
      {
        type: "metrics",
        turnId: "t1",
        textReadyMs: 1_000_000,
        firstAudioByteMs: 1_000_454,
        firstAudioPlayedMs: 1_000_459,
        lastAudioPlayedMs: 1_008_439,
      },
    ]);
    render(<Timeline record={record} textTurnIds={new Set(["t1"])} />);

    expect(screen.getByTestId("timeline-text-turn")).toHaveTextContent(/nothing transcribed you/i);
    expect(screen.getByTestId("timeline-text-turn")).toHaveTextContent(/still spoken/i);
    // The real waterfall is drawn, not suppressed: 454ms to the first audio byte.
    expect(screen.getByTitle(/voice \(to first audio\)/i)).toBeInTheDocument();
    expect(screen.getByTestId("timeline-lane")).toHaveTextContent("454ms");
    // A typed turn cannot have been cut off by an endpointer that never ran.
    expect(screen.queryByTestId("fast-turn-warning")).not.toBeInTheDocument();
  });

  it("keeps a spoken turn's audio stages when only some turns were typed", () => {
    const record = recordFrom([
      { type: "metrics", turnId: "t1", speechEndMs: 0, textReadyMs: 300, firstAudioByteMs: 1500, e2eMs: 2000 },
      { type: "metrics", turnId: "t2", llmTTFTMs: 500, e2eMs: 900 },
    ]);
    render(<Timeline record={record} textTurnIds={new Set(["t2"])} />);

    expect(screen.getAllByTestId("timeline-lane")).toHaveLength(2);
    expect(screen.getByTitle(/deciding you're done/i)).toBeInTheDocument();
    expect(screen.getAllByTestId("timeline-text-turn")).toHaveLength(1);
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

  it("names the endpointing owner in plain language — speech-to-text provider", () => {
    const record = recordFrom([
      { type: "metrics", turnId: "t1", speechEndMs: 0, textReadyMs: 300, firstAudioByteMs: 1500, e2eMs: 2000, endpointingOwner: "provider_stt", endpointingReason: "end_of_speech" },
    ]);
    render(<Timeline record={record} />);
    const marker = screen.getByTestId("timeline-endpointing");
    expect(marker).toHaveAttribute("data-endpoint-kind", "endpoint");
    expect(marker).toHaveTextContent(/speech-to-text provider/i);
    expect(marker).toHaveTextContent(/finished speaking/i);
    // No raw enum value leaks into user-facing text.
    expect(marker).not.toHaveTextContent("provider_stt");
  });

  it("names the endpointing owner in plain language — Smart Turn", () => {
    const record = recordFrom([
      { type: "metrics", turnId: "t1", speechEndMs: 0, textReadyMs: 300, firstAudioByteMs: 1500, e2eMs: 2000, endpointingOwner: "smart_turn", endpointingReason: "end_of_speech" },
    ]);
    render(<Timeline record={record} />);
    expect(screen.getByTestId("timeline-endpointing")).toHaveTextContent(/smart turn/i);
  });

  it("calls out a force-finalized turn as a timeout, not a natural endpoint", () => {
    const record = recordFrom([
      { type: "metrics", turnId: "t1", speechEndMs: 0, textReadyMs: 300, firstAudioByteMs: 1500, e2eMs: 2000, endpointingOwner: "provider_stt", endpointingReason: "force_finalized" },
    ]);
    render(<Timeline record={record} />);
    const marker = screen.getByTestId("timeline-endpointing");
    expect(marker).toHaveAttribute("data-endpoint-kind", "endpoint");
    expect(marker).toHaveTextContent(/force-finalized/i);
    expect(marker).toHaveTextContent(/timeout/i);
  });

  it("detects a typed turn from the wire and never claims an endpointer fired", () => {
    // No textTurnIds passed — the wire itself carries owner "text" on the metrics
    // message. The timeline must light up the typed note from that signal alone.
    const record = recordFrom([
      { type: "metrics", turnId: "t1", textReadyMs: 100, firstAudioByteMs: 600, e2eMs: 900, endpointingOwner: "text", endpointingReason: "typed" },
    ]);
    render(<Timeline record={record} />);
    expect(screen.getByTestId("timeline-text-turn")).toBeInTheDocument();
    // A typed turn must not render an endpoint marker — nothing endpointed it.
    expect(screen.queryByTestId("timeline-endpointing")).not.toBeInTheDocument();
  });

  it("says the cause is unknown when the backend omits the owner, rather than guessing", () => {
    const record = recordFrom([
      { type: "metrics", turnId: "t1", speechEndMs: 0, textReadyMs: 300, firstAudioByteMs: 1500, e2eMs: 2000 },
    ]);
    render(<Timeline record={record} />);
    const marker = screen.getByTestId("timeline-endpointing");
    expect(marker).toHaveAttribute("data-endpoint-kind", "unknown");
    expect(marker).toHaveTextContent(/unknown/i);
  });
});
