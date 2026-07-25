import { buildSessionRecord } from "@kuralle-syrinx/browser-client/record";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MetricsPanel } from "./MetricsPanel";

const recordFrom = (msgs: readonly unknown[]) =>
  buildSessionRecord(msgs.map((m, i) => ({ message: m as never, atMs: i })));

describe("MetricsPanel", () => {
  it("says there are no turns yet rather than showing zeroes", () => {
    render(<MetricsPanel record={recordFrom([])} />);
    expect(screen.getByTestId("metrics-unavailable")).toHaveTextContent(/no turns yet/i);
  });

  it("explains when turns happened but the backend sent no timings", () => {
    // A table of zeroes here would read as "everything is instant" — the Workers case.
    const record = recordFrom([
      { type: "agent_chunk", turnId: "t1", text: "a" },
      { type: "agent_chunk", turnId: "t2", text: "b" },
    ]);
    render(<MetricsPanel record={record} />);
    expect(screen.getByTestId("metrics-unavailable")).toHaveTextContent(/2 turns recorded/i);
    expect(screen.getByTestId("metrics-unavailable")).toHaveTextContent(/no per-turn timings/i);
  });

  it("renders a row per stage that has data", () => {
    const record = recordFrom([
      { type: "metrics", turnId: "t1", sttMs: 100, llmTTFTMs: 900, e2eMs: 1500 },
      { type: "metrics", turnId: "t2", sttMs: 200, llmTTFTMs: 1100, e2eMs: 1900 },
    ]);
    render(<MetricsPanel record={record} />);
    expect(screen.getByTestId("metrics-row-stt")).toBeInTheDocument();
    expect(screen.getByTestId("metrics-row-llm")).toBeInTheDocument();
    expect(screen.queryByTestId("metrics-row-tts")).not.toBeInTheDocument(); // no tts data
  });

  it("discloses when aggregates cover only some turns", () => {
    const record = recordFrom([
      { type: "metrics", turnId: "t1", e2eMs: 1500 },
      { type: "agent_chunk", turnId: "t2", text: "no metrics" },
    ]);
    render(<MetricsPanel record={record} />);
    expect(screen.getByTestId("metrics-partial")).toHaveTextContent(/1 of 2 turns/i);
  });

  it("warns about implausibly fast turns instead of presenting them as good", () => {
    const record = recordFrom([
      { type: "metrics", turnId: "t1", e2eMs: 1500 },
      { type: "metrics", turnId: "premature", e2eMs: 420 },
    ]);
    render(<MetricsPanel record={record} />);
    const warn = screen.getByTestId("metrics-fast-warning");
    expect(warn).toHaveTextContent(/premature/);
    expect(warn).toHaveTextContent(/still speaking/i);
    expect(warn).toHaveTextContent(/not a fast agent/i);
  });

  it("does not warn when every turn is above the floor", () => {
    const record = recordFrom([{ type: "metrics", turnId: "t1", e2eMs: 1500 }]);
    render(<MetricsPanel record={record} />);
    expect(screen.queryByTestId("metrics-fast-warning")).not.toBeInTheDocument();
  });
});
