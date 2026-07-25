// SPDX-License-Identifier: MIT

import { buildSessionRecord } from "@kuralle-syrinx/browser-client/record";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AgentErrorPanel } from "./AgentErrorPanel";
import { TranscriptPanel } from "./TranscriptPanel";

const recordFrom = (msgs: readonly unknown[]) =>
  buildSessionRecord(msgs.map((m, i) => ({ message: m as never, atMs: i * 100 })));

describe("AgentErrorPanel", () => {
  it("shows nothing on a clean session", () => {
    const { container } = render(
      <AgentErrorPanel record={recordFrom([{ type: "turn_complete", turnId: "t1", transcript: "hi" }])} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("names which part failed, in words, and keeps the raw component beside it", () => {
    render(
      <AgentErrorPanel
        record={recordFrom([
          { type: "error", turnId: "t1", component: "stt.error", category: "authentication", message: "401 from Deepgram" },
        ])}
      />,
    );
    expect(screen.getByTestId("agent-error-subject")).toHaveTextContent("Transcription failed");
    expect(screen.getByTestId("agent-error-message")).toHaveTextContent("401 from Deepgram");
    expect(screen.getByTestId("agent-error-raw")).toHaveTextContent("stt.error · authentication");
    expect(screen.getByTestId("agent-error-cause")).toHaveTextContent(/check the API key/i);
  });

  it("correlates each error with its turn, and says so when there is no turn", () => {
    render(
      <AgentErrorPanel
        record={recordFrom([
          { type: "error", component: "session", category: "initialization", message: "no key" },
          { type: "error", turnId: "t7", component: "llm.error", category: "rate_limit", message: "429" },
        ])}
      />,
    );
    const wheres = screen.getAllByTestId("agent-error-where").map((el) => el.textContent);
    expect(wheres.some((text) => text?.includes("turn t7"))).toBe(true);
    expect(wheres.some((text) => text?.includes("outside any turn"))).toBe(true);
  });

  it("renders a recoverable error visually distinct from a fatal one", () => {
    render(
      <AgentErrorPanel
        record={recordFrom([
          { type: "error", turnId: "t1", component: "llm.error", category: "rate_limit", message: "429" },
          { type: "error", turnId: "t2", component: "tts.error", category: "authentication", message: "401" },
        ])}
      />,
    );
    const rows = screen.getAllByTestId("agent-error");
    const severities = rows.map((row) => row.getAttribute("data-severity"));
    expect(new Set(severities)).toEqual(new Set(["recoverable", "fatal"]));
    // Distinct in words too, not only in colour.
    const labels = screen.getAllByTestId("agent-error-severity").map((el) => el.textContent);
    expect(labels).toContain("Session survived");
    expect(labels).toContain("Ended the session");
    // And distinct in class, so the difference survives a greyscale screenshot check.
    const classes = rows.map((row) => row.className);
    expect(new Set(classes).size).toBe(2);
  });

  it("says the effect is not known rather than guessing at an unmapped category", () => {
    render(
      <AgentErrorPanel
        record={recordFrom([
          { type: "error", turnId: "t1", component: "llm.error", category: "brand_new", message: "?" },
        ])}
      />,
    );
    expect(screen.getByTestId("agent-error")).toHaveAttribute("data-severity", "unknown");
    expect(screen.getByTestId("agent-error-severity")).toHaveTextContent("Effect not known");
    expect(screen.getByTestId("agent-error-unknown")).toHaveTextContent(/not one the studio can map/i);
  });

  it("keeps every error, rather than the latest replacing the one before", () => {
    // The failure a toast causes: the error that matters is usually the older one.
    render(
      <AgentErrorPanel
        record={recordFrom([
          { type: "error", turnId: "t1", component: "llm.error", category: "rate_limit", message: "first" },
          { type: "error", turnId: "t2", component: "llm.error", category: "network_timeout", message: "second" },
          { type: "error", turnId: "t3", component: "llm.error", category: "rate_limit", message: "third" },
        ])}
      />,
    );
    expect(screen.getAllByTestId("agent-error")).toHaveLength(3);
    expect(screen.getByTestId("agent-errors-summary")).toHaveTextContent(/3 reported this session/i);
    expect(screen.getByTestId("agent-errors-summary")).toHaveTextContent(/3 the session survived/i);
    // Newest first.
    expect(screen.getAllByTestId("agent-error-message")[0]).toHaveTextContent("third");
  });

  it("renders an injected reasoner error without terminating the session view", () => {
    // LDT-13's done-condition. A recoverable llm.error must leave the conversation
    // intact and readable — the turn it happened in included.
    const record = recordFrom([
      { type: "stt_output", turnId: "t1", transcript: "book me a table" },
      { type: "error", turnId: "t1", component: "llm.error", category: "rate_limit", message: "429 slow down" },
      { type: "agent_chunk", turnId: "t1", text: "Sorry, let me try again." },
      { type: "turn_complete", turnId: "t1", transcript: "book me a table" },
    ]);

    render(
      <>
        <AgentErrorPanel record={record} />
        <TranscriptPanel record={record} />
      </>,
    );

    expect(screen.getByTestId("agent-error")).toHaveAttribute("data-severity", "recoverable");
    expect(screen.getByTestId("agent-error-severity")).toHaveTextContent("Session survived");
    // The view is still a session view: the turn, its transcript and the reply survive.
    expect(screen.getByText("book me a table")).toBeInTheDocument();
    expect(screen.getByText(/let me try again/i)).toBeInTheDocument();
  });

  it("uses plain language in the headline, never the message name", () => {
    render(
      <AgentErrorPanel
        record={recordFrom([
          { type: "error", turnId: "t1", component: "llm.error", category: "rate_limit", message: "429" },
        ])}
      />,
    );
    // Design rule 1: the prose says what failed; the raw string stays in its own row.
    expect(screen.getByTestId("agent-error-subject")).toHaveTextContent("The reasoner failed");
    expect(screen.getByTestId("agent-error-subject")).not.toHaveTextContent("llm.error");
  });
});
