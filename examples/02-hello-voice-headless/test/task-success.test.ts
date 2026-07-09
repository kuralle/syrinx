// SPDX-License-Identifier: MIT
//
// IP-C6: deterministic unit tests for the task-success scorer (the new half of the
// InteractionPolicy eval matrix; the turn-taking half reuses eva-evaluator).

import { describe, it, expect } from "vitest";
import {
  scoreTask,
  taskSuccessRate,
  DEFAULT_VOICE_TASKS,
  type VoiceTaskSpec,
  type TaskTrace,
} from "../scripts/task-success.js";

const SPEC: VoiceTaskSpec = {
  id: "t",
  prompt: "p",
  requiredTools: ["consult_knowledge"],
  successRule: (trace) => trace.finalText.toLowerCase().includes("transcript"),
};

describe("scoreTask", () => {
  it("succeeds when the required tool is called and the domain rule holds", () => {
    const trace: TaskTrace = {
      toolCalls: [{ name: "consult_knowledge", args: { query: "documents" } }],
      finalText: "You need your transcript and two references.",
    };
    const r = scoreTask(SPEC, trace);
    expect(r.success).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it("fails (with a reason) when a required tool was not called", () => {
    const trace: TaskTrace = { toolCalls: [], finalText: "You need your transcript." };
    const r = scoreTask(SPEC, trace);
    expect(r.success).toBe(false);
    expect(r.reasons).toContain("missing required tool: consult_knowledge");
  });

  it("fails when the domain rule is not satisfied even if the tool was called", () => {
    const trace: TaskTrace = {
      toolCalls: [{ name: "consult_knowledge", args: {} }],
      finalText: "I'm not sure, sorry.",
    };
    const r = scoreTask(SPEC, trace);
    expect(r.success).toBe(false);
    expect(r.reasons).toContain("domain success rule not satisfied");
  });

  it("captures a throwing success rule as a reason rather than crashing", () => {
    const bad: VoiceTaskSpec = {
      ...SPEC,
      successRule: () => {
        throw new Error("boom");
      },
    };
    const r = scoreTask(bad, { toolCalls: [{ name: "consult_knowledge", args: {} }], finalText: "" });
    expect(r.success).toBe(false);
    expect(r.reasons.some((x) => x.includes("success rule threw"))).toBe(true);
  });
});

describe("taskSuccessRate", () => {
  it("is the fraction of successful tasks", () => {
    expect(
      taskSuccessRate([
        { id: "a", success: true, reasons: [] },
        { id: "b", success: false, reasons: ["x"] },
        { id: "c", success: true, reasons: [] },
        { id: "d", success: true, reasons: [] },
      ]),
    ).toBeCloseTo(0.75, 5);
  });

  it("is NaN when no tasks were run (so an empty sweep never reads as 100%)", () => {
    expect(Number.isNaN(taskSuccessRate([]))).toBe(true);
  });
});

describe("DEFAULT_VOICE_TASKS", () => {
  it("scores a faithful trace of the default set at 1.0", () => {
    const traces: Record<string, TaskTrace> = {
      "cs-masters-documents": {
        toolCalls: [{ name: "consult_knowledge", args: { query: "documents" } }],
        finalText: "You need your transcript and a statement of purpose.",
      },
      "application-deadline": {
        toolCalls: [{ name: "consult_knowledge", args: { query: "deadline" } }],
        finalText: "The deadline is March 15.",
      },
      "tuition-fee": {
        toolCalls: [{ name: "consult_knowledge", args: { query: "fee" } }],
        finalText: "The tuition fee is 12000 per year.",
      },
    };
    const results = DEFAULT_VOICE_TASKS.map((spec) => scoreTask(spec, traces[spec.id]!));
    expect(taskSuccessRate(results)).toBeCloseTo(1.0, 5);
  });
});
