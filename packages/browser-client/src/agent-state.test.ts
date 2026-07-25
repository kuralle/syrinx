// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
  deriveAgentState,
  INITIAL_AGENT_STATE,
  isStalled,
  nextAgentState,
  type AgentState,
} from "./agent-state.js";

const at = (message: unknown, atMs: number) => ({ message: message as never, atMs });

/** Fold a stream and return just the state, for readability. */
const stateAfter = (msgs: readonly { message: never; atMs: number }[]): AgentState =>
  deriveAgentState(msgs).state;

describe("agent state — the full turn cycle", () => {
  it("walks idle → listening → endpointing → thinking → speaking → idle", () => {
    const seen: AgentState[] = [];
    let s = INITIAL_AGENT_STATE;
    seen.push(s.state);
    for (const [m, t] of [
      [{ type: "speech_started", turnId: "t1" }, 0],
      [{ type: "speech_ended", turnId: "t1" }, 1000],
      [{ type: "stt_output", turnId: "t1", transcript: "hi" }, 1200],
      [{ type: "tts_chunk", turnId: "t1", byteLength: 100 }, 2000],
      [{ type: "tts_end", turnId: "t1" }, 4000],
    ] as const) {
      s = nextAgentState(s, m as never, t as number);
      seen.push(s.state);
    }
    expect(seen).toEqual(["idle", "listening", "endpointing", "thinking", "speaking", "idle"]);
  });

  it("tracks the turnId through the cycle", () => {
    const s = deriveAgentState([
      at({ type: "speech_started", turnId: "t7" }, 0),
      at({ type: "tts_chunk", turnId: "t7" }, 10),
    ]);
    expect(s.turnId).toBe("t7");
  });
});

describe("agent state — interruption", () => {
  it("goes to interrupted from speaking", () => {
    expect(stateAfter([
      at({ type: "tts_chunk", turnId: "t1" }, 0),
      at({ type: "agent_interrupted", turnId: "t1", reason: "user_speech" }, 500),
    ])).toBe("interrupted");
  });

  it("holds interrupted through tts_end rather than settling to idle", () => {
    // The UI must be able to show that the turn was cut off, not that it ended normally.
    expect(stateAfter([
      at({ type: "tts_chunk", turnId: "t1" }, 0),
      at({ type: "agent_interrupted", turnId: "t1" }, 500),
      at({ type: "tts_end", turnId: "t1" }, 510),
    ])).toBe("interrupted");
  });

  it("leaves interrupted when the next turn starts", () => {
    expect(stateAfter([
      at({ type: "tts_chunk", turnId: "t1" }, 0),
      at({ type: "agent_interrupted", turnId: "t1" }, 500),
      at({ type: "speech_started", turnId: "t2" }, 600),
    ])).toBe("listening");
  });

  it("shows listening the moment the caller speaks over the agent", () => {
    // Barge-in is legible from speech_started alone — no wait for the interrupt message.
    expect(stateAfter([
      at({ type: "tts_chunk", turnId: "t1" }, 0),
      at({ type: "speech_started", turnId: "t2" }, 100),
    ])).toBe("listening");
  });
});

describe("agent state — tools", () => {
  it("stays thinking across a tool call", () => {
    expect(stateAfter([
      at({ type: "stt_output", turnId: "t1", transcript: "q" }, 0),
      at({ type: "agent_tool_call", turnId: "t1", id: "c1", name: "lookup" }, 10),
      at({ type: "tool_call_delayed", turnId: "t1", toolId: "c1", afterMs: 800 }, 900),
    ])).toBe("thinking");
  });

  it("agent_chunk before audio is thinking, not speaking", () => {
    // Text has arrived but nothing is audible — the caller still hears silence.
    expect(stateAfter([
      at({ type: "stt_output", turnId: "t1", transcript: "q" }, 0),
      at({ type: "agent_chunk", turnId: "t1", text: "The" }, 10),
    ])).toBe("thinking");
  });

  it("agent_chunk after audio starts keeps it speaking", () => {
    expect(stateAfter([
      at({ type: "tts_chunk", turnId: "t1" }, 0),
      at({ type: "agent_chunk", turnId: "t1", text: "more" }, 10),
    ])).toBe("speaking");
  });
});

describe("agent state — robustness", () => {
  it("ignores unknown message types", () => {
    // Proven on Cloudflare: the agents SDK sends these before `ready`.
    expect(stateAfter([
      at({ type: "cf_agent_identity" }, 0),
      at({ type: "cf_agent_mcp_servers" }, 1),
      at({ type: "some_future_message", turnId: "t1" }, 2),
    ])).toBe("idle");
  });

  it("does not reset sinceMs when a message re-asserts the same state", () => {
    const a = nextAgentState(INITIAL_AGENT_STATE, { type: "tts_chunk", turnId: "t1" } as never, 100);
    const b = nextAgentState(a, { type: "tts_chunk", turnId: "t1" } as never, 900);
    expect(b.state).toBe("speaking");
    expect(b.sinceMs).toBe(100); // held since the first chunk, not the latest
  });

  it("is pure — the previous snapshot is unchanged", () => {
    const before = INITIAL_AGENT_STATE;
    nextAgentState(before, { type: "speech_started" } as never, 5);
    expect(before).toEqual({ state: "idle", sinceMs: 0 });
  });
});

describe("agent state — stall detection", () => {
  it("flags an endpointing state held too long", () => {
    const s = { state: "endpointing" as const, sinceMs: 0 };
    expect(isStalled(s, 4_000)).toBe(false);
    expect(isStalled(s, 6_000)).toBe(true); // 5s threshold — a stuck endpointer
  });

  it("never flags idle", () => {
    expect(isStalled({ state: "idle", sinceMs: 0 }, 10_000_000)).toBe(false);
  });

  it("flags a hung tool call as a stalled thinking state", () => {
    expect(isStalled({ state: "thinking", sinceMs: 0 }, 31_000)).toBe(true);
  });
});
