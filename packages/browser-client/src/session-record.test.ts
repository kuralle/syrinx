// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import {
  applyMessage,
  buildSessionRecord,
  DEFAULT_LIMITS,
  emptySessionRecord,
  type SessionRecord,
  type ToolCall,
  type TurnRecord,
} from "./session-record.js";

const at = (message: unknown, atMs: number) => ({ message: message as never, atMs });

/** Index into turns/toolCalls with a loud failure instead of a non-null assertion. */
function turnAt(r: SessionRecord, i: number): TurnRecord {
  const t = r.turns[i];
  if (!t) throw new Error(`expected a turn at index ${i}, got ${r.turns.length} turn(s)`);
  return t;
}
function toolAt(t: TurnRecord, i: number): ToolCall {
  const c = t.toolCalls[i];
  if (!c) throw new Error(`expected a tool call at index ${i}, got ${t.toolCalls.length}`);
  return c;
}

describe("session record — config", () => {
  it("captures negotiated params from ready", () => {
    const r = buildSessionRecord([
      at({ type: "ready", sessionId: "s1", resumeWindowMs: 30_000, audio: { inputSampleRateHz: 16000, outputSampleRateHz: 24000, encoding: "pcm_s16le", channels: 1, binaryEnvelope: "syrinx.audio.v1" } }, 0),
    ]);
    expect(r.config.sessionId).toBe("s1");
    expect(r.config.inputSampleRateHz).toBe(16000);
    expect(r.config.outputSampleRateHz).toBe(24000);
    expect(r.config.encoding).toBe("pcm_s16le");
    expect(r.config.binaryEnvelope).toBe("syrinx.audio.v1");
    expect(r.config.resumeWindowMs).toBe(30_000);
    expect(r.turns).toHaveLength(0);
  });

  it("keeps a caller-supplied wsUrl", () => {
    const r = applyMessage(emptySessionRecord({ wsUrl: "ws://x/ws" }), { type: "ready" } as never, 0);
    expect(r.config.wsUrl).toBe("ws://x/ws");
  });
});

describe("session record — unknown message types", () => {
  // Proven on the Cloudflare path: the agents SDK sends these before `ready`.
  it("tolerates cf_agent_* arriving before ready without throwing or creating turns", () => {
    const r = buildSessionRecord([
      at({ type: "cf_agent_identity", id: "abc" }, 0),
      at({ type: "cf_agent_mcp_servers", servers: [] }, 1),
      at({ type: "ready", audio: { inputSampleRateHz: 16000 } }, 2),
    ]);
    expect(r.turns).toHaveLength(0);
    expect(r.sessionEvents).toHaveLength(3);
    expect(r.config.inputSampleRateHz).toBe(16000);
  });

  it("retains an unknown type that carries a turnId without corrupting the turn", () => {
    const r = buildSessionRecord([
      at({ type: "agent_chunk", turnId: "t1", text: "hi" }, 0),
      at({ type: "some_future_message", turnId: "t1", whatever: true }, 1),
    ]);
    expect(turnAt(r, 0).agentText).toBe("hi");
    expect(turnAt(r, 0).events).toHaveLength(2);
  });
});

describe("session record — turn assembly", () => {
  it("folds a complete turn across every mutating message type", () => {
    const r = buildSessionRecord([
      at({ type: "speech_started", turnId: "t1" }, 0),
      at({ type: "speech_ended", turnId: "t1" }, 100),
      at({ type: "stt_chunk", turnId: "t1", transcript: "what is the" }, 120),
      at({ type: "stt_output", turnId: "t1", transcript: "what is the deadline", confidence: 0.94 }, 200),
      at({ type: "agent_tool_call", turnId: "t1", id: "c1", name: "lookup", args: { q: 1 } }, 210),
      at({ type: "tool_call_started", turnId: "t1", toolId: "c1", toolName: "lookup" }, 211),
      at({ type: "tool_call_delayed", turnId: "t1", toolId: "c1", toolName: "lookup", afterMs: 800 }, 1000),
      at({ type: "agent_tool_result", turnId: "t1", id: "c1", result: "March 1" }, 1100),
      at({ type: "tool_call_complete", turnId: "t1", toolId: "c1", toolName: "lookup" }, 1101),
      at({ type: "agent_chunk", turnId: "t1", text: "The deadline " }, 1200),
      at({ type: "agent_chunk", turnId: "t1", text: "is March 1." }, 1250),
      at({ type: "tts_chunk", turnId: "t1", byteLength: 4000 }, 1300),
      at({ type: "tts_chunk", turnId: "t1", byteLength: 6000 }, 1350),
      at({ type: "agent_end", turnId: "t1" }, 1400),
      at({ type: "tts_end", turnId: "t1" }, 1500),
      at({ type: "turn_complete", turnId: "t1", transcript: "what is the deadline" }, 1550),
      at({ type: "metrics", turnId: "t1", speechEndMs: 100, llmTTFTMs: 900, ttsTTFBMs: 100, e2eMs: 1450 }, 1600),
    ]);

    const t = turnAt(r, 0);
    expect(r.turns).toHaveLength(1);
    expect(t.userTranscript).toBe("what is the deadline");
    expect(t.userInterim).toBeUndefined(); // interim replaced in place by the final
    expect(t.userConfidence).toBe(0.94);
    expect(t.agentText).toBe("The deadline is March 1."); // chunks concatenated in order
    expect(t.ttsAudioBytes).toBe(10_000);
    expect(t.complete).toBe(true);
    expect(t.timings?.llmTTFTMs).toBe(900);
    expect(t.timings).not.toHaveProperty("turnId"); // envelope fields stripped
    expect(t.toolCalls).toHaveLength(1); // one call, not four — merged by id
    expect(toolAt(t, 0)).toMatchObject({ name: "lookup", result: "March 1", phase: "complete", afterMs: 800 });
  });

  it("records an interruption with its reason", () => {
    const r = buildSessionRecord([
      at({ type: "agent_chunk", turnId: "t1", text: "The dead" }, 0),
      at({ type: "agent_interrupted", turnId: "t1", reason: "user_speech" }, 1400),
    ]);
    expect(turnAt(r, 0).interrupted).toEqual({ atMs: 1400, reason: "user_speech" });
    expect(turnAt(r, 0).complete).toBe(false);
  });

  it("keeps a turn that never completes", () => {
    const r = buildSessionRecord([at({ type: "speech_started", turnId: "t1" }, 0)]);
    expect(turnAt(r, 0).complete).toBe(false);
    expect(turnAt(r, 0).timings).toBeUndefined(); // Workers path emits no metrics
  });

  it("collects errors without ending the turn", () => {
    const r = buildSessionRecord([
      at({ type: "agent_chunk", turnId: "t1", text: "a" }, 0),
      at({ type: "error", turnId: "t1", component: "llm", category: "recoverable", message: "rate limited" }, 10),
      at({ type: "agent_chunk", turnId: "t1", text: "b" }, 20),
    ]);
    expect(turnAt(r, 0).errors).toEqual([{ atMs: 10, component: "llm", category: "recoverable", message: "rate limited" }]);
    expect(turnAt(r, 0).agentText).toBe("ab");
  });

  it("separates turns by turnId and tolerates interleaving", () => {
    const r = buildSessionRecord([
      at({ type: "agent_chunk", turnId: "t1", text: "one" }, 0),
      at({ type: "agent_chunk", turnId: "t2", text: "two" }, 1),
      at({ type: "agent_chunk", turnId: "t1", text: "!" }, 2),
    ]);
    expect(r.turns.map((t) => t.agentText)).toEqual(["one!", "two"]);
  });

  it("creates a turn from whichever message arrives first, out of order", () => {
    const r = buildSessionRecord([
      at({ type: "turn_complete", turnId: "t1", transcript: "late" }, 0),
      at({ type: "speech_started", turnId: "t1" }, 1),
    ]);
    expect(r.turns).toHaveLength(1);
    expect(turnAt(r, 0).userTranscript).toBe("late");
  });
});

describe("session record — bounded by construction", () => {
  it("evicts oldest turns past the cap and counts the loss", () => {
    const limits = { maxTurns: 3, maxEventsPerTurn: 100 };
    const msgs = Array.from({ length: 6 }, (_, i) => at({ type: "agent_chunk", turnId: `t${i}`, text: "x" }, i));
    const r = buildSessionRecord(msgs, {}, limits);
    expect(r.turns).toHaveLength(3);
    expect(r.turns.map((t) => t.turnId)).toEqual(["t3", "t4", "t5"]); // newest kept
    expect(r.droppedTurns).toBe(3); // surfaced, not silent
  });

  it("caps events per turn and counts the loss", () => {
    const limits = { maxEventsPerTurn: 5, maxTurns: 10 };
    const msgs = Array.from({ length: 12 }, (_, i) => at({ type: "tts_chunk", turnId: "t1", byteLength: 1 }, i));
    const r = buildSessionRecord(msgs, {}, limits);
    expect(turnAt(r, 0).events).toHaveLength(5);
    expect(turnAt(r, 0).droppedEvents).toBe(7);
    expect(turnAt(r, 0).ttsAudioBytes).toBe(12); // derived state survives event eviction
  });

  it("has sane defaults", () => {
    expect(DEFAULT_LIMITS.maxTurns).toBe(50);
    expect(DEFAULT_LIMITS.maxEventsPerTurn).toBe(500);
  });
});

describe("session record — purity", () => {
  it("does not mutate the input record", () => {
    const before: SessionRecord = emptySessionRecord();
    const after = applyMessage(before, { type: "agent_chunk", turnId: "t1", text: "x" } as never, 0);
    expect(before.turns).toHaveLength(0);
    expect(after.turns).toHaveLength(1);
  });

  it("is deterministic — same input, same output", () => {
    const msgs = [at({ type: "agent_chunk", turnId: "t1", text: "a" }, 0), at({ type: "turn_complete", turnId: "t1" }, 1)];
    expect(buildSessionRecord(msgs)).toEqual(buildSessionRecord(msgs));
  });
});

describe("session record — endpointing decision", () => {
  it("folds the owner/reason from metrics onto the turn, not into timings", () => {
    const r = buildSessionRecord([
      at({ type: "metrics", turnId: "t1", speechEndMs: 100, e2eMs: 500, endpointingOwner: "smart_turn", endpointingReason: "end_of_speech" }, 0),
    ]);
    const t = turnAt(r, 0);
    expect(t.endpointingOwner).toBe("smart_turn");
    expect(t.endpointingReason).toBe("end_of_speech");
    // The decision is a fact about the turn, not a timing — it must not leak into timings.
    expect(t.timings).not.toHaveProperty("endpointingOwner");
    expect(t.timings).not.toHaveProperty("endpointingReason");
  });

  it("omits the decision when metrics does not carry it (absent means absent)", () => {
    const r = buildSessionRecord([
      at({ type: "metrics", turnId: "t1", speechEndMs: 100, e2eMs: 500 }, 0),
    ]);
    const t = turnAt(r, 0);
    expect(t.endpointingOwner).toBeUndefined();
    expect(t.endpointingReason).toBeUndefined();
  });

  it("carries a force-finalized reason onto the turn", () => {
    const r = buildSessionRecord([
      at({ type: "metrics", turnId: "t1", speechEndMs: 100, e2eMs: 500, endpointingOwner: "provider_stt", endpointingReason: "force_finalized" }, 0),
    ]);
    expect(turnAt(r, 0).endpointingReason).toBe("force_finalized");
  });
});
