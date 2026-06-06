// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { reasoningResume, reasoningSuspended } from "./packet-factories.js";

describe("reasoningSuspended", () => {
  it("returns a reasoning.suspended packet with the expected shape", () => {
    const pkt = reasoningSuspended("ctx-1", 1234, "run-1", { step: 3 }, "Pause for input.");

    expect(pkt).toEqual({
      kind: "reasoning.suspended",
      contextId: "ctx-1",
      timestampMs: 1234,
      runId: "run-1",
      prompt: "Pause for input.",
      payload: { step: 3 },
    });
  });
});

describe("reasoningResume", () => {
  it("returns a reasoning.resume packet with the expected shape", () => {
    const pkt = reasoningResume("ctx-1", 5678, "run-1", "user answer");

    expect(pkt).toEqual({
      kind: "reasoning.resume",
      contextId: "ctx-1",
      timestampMs: 5678,
      runId: "run-1",
      data: "user answer",
    });
  });
});
