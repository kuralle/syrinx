import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AgentStateBadge } from "./AgentStateBadge";

describe("AgentStateBadge", () => {
  it("labels states in plain language, not packet names", () => {
    render(<AgentStateBadge snapshot={{ state: "endpointing", sinceMs: performance.now() }} />);
    expect(screen.getByText(/deciding you're done/i)).toBeInTheDocument();
    expect(screen.queryByText(/eos/i)).not.toBeInTheDocument();
  });

  it("exposes the raw state for styling and tests", () => {
    render(<AgentStateBadge snapshot={{ state: "speaking", sinceMs: performance.now() }} />);
    expect(screen.getByTestId("agent-state-badge")).toHaveAttribute("data-state", "speaking");
  });

  it("flags a state held past its stall threshold", () => {
    // endpointing stalls after 5s — a stuck endpointer is a real, common failure.
    render(<AgentStateBadge snapshot={{ state: "endpointing", sinceMs: performance.now() - 30_000 }} />);
    expect(screen.getByTestId("agent-state-badge")).toHaveAttribute("data-stalled", "true");
  });

  it("never flags idle as stalled", () => {
    render(<AgentStateBadge snapshot={{ state: "idle", sinceMs: 0 }} />);
    expect(screen.getByTestId("agent-state-badge")).toHaveAttribute("data-stalled", "false");
  });

  it("hides the elapsed timer when idle", () => {
    render(<AgentStateBadge snapshot={{ state: "idle", sinceMs: 0 }} />);
    expect(screen.queryByText(/\ds$/)).not.toBeInTheDocument();
  });
});
