// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { evaluateConversation as evaluateInteractiveConversation } from "../scripts/run-websocket-university-interactive.js";
import { evaluateConversation as evaluateMultiturnConversation } from "../scripts/run-websocket-university-multiturn.js";

describe("websocket smoke quality gates", () => {
  it("keeps interactive fixture transcript and agent wording checks diagnostic", () => {
    const evaluation = evaluateInteractiveConversation([
      {
        id: "turn-1",
        fixtureId: "fixture-1",
        inputText: "expected fixture text",
        requiredTerms: ["biology"],
        inputAudioMs: 1000,
        startedAtMs: 0,
        speechStartedAtMs: 10,
        speechStartedCount: 1,
        audioEndedAtMs: 1000,
        speechEndedAtMs: 1200,
        speechEndedCount: 1,
        sttFinalAtMs: 1400,
        firstAgentAtMs: 1600,
        firstAudioAtMs: 1900,
        agentEndedAtMs: 1800,
        ttsEndedAtMs: 2200,
        transcript: "hello",
        agentReply: "ok",
        toolCalls: [],
        audioBytes: 32000,
        error: "",
      },
    ]);

    expect(evaluation.failures).toStrictEqual([]);
    expect(evaluation.diagnostics).toContain("turn-1 STT transcript missed fixture term biology");
    expect(evaluation.diagnostics).toContain("turn-1 agent reply did not end cleanly");
    expect(evaluation.diagnostics).toContain("turn-1 agent reply was short");
  });

  it("keeps multiturn tool and agent-content checks diagnostic", () => {
    const evaluation = evaluateMultiturnConversation([
      {
        id: "turn-1",
        fixtureId: "fixture-1",
        inputText: "expected fixture text",
        inputAudioMs: 1000,
        startedAtMs: 0,
        speechStartedAtMs: 10,
        speechStartedCount: 1,
        audioEndedAtMs: 1000,
        speechEndedAtMs: 1200,
        speechEndedCount: 1,
        sttFinalAtMs: 1400,
        firstAgentAtMs: 1600,
        firstAudioAtMs: 1900,
        agentEndedAtMs: 1800,
        ttsEndedAtMs: 2200,
        transcript: "hello",
        agentReply: "ok",
        toolCalls: [],
        audioChunks: [new Uint8Array(24000)],
        error: "",
      },
    ], 1000);

    expect(evaluation.failures).toStrictEqual([]);
    expect(evaluation.diagnostics).toContain("modeled conversation was 1000ms, expected at least 480000ms");
    expect(evaluation.diagnostics).toContain("expected tools on at least half of turns, got 0 calls across 1 turns");
    expect(evaluation.diagnostics).toContain("expected tool call missing on turn-1");
    expect(evaluation.diagnostics).toContain("first STT transcript missed fixture term Biology");
    expect(evaluation.diagnostics).toContain("first reply missed late add guidance");
    expect(evaluation.diagnostics).toContain("agent never referenced the Student Relations case number");
    expect(evaluation.diagnostics).toContain("turn-1 agent reply did not end cleanly");
    expect(evaluation.diagnostics).toContain("turn-1 agent reply was short");
  });
});
