// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { injectMessage, reasoningResume, reasoningSuspended, sttPartial, sttReconfigure } from "./packet-factories.js";

describe("sttPartial", () => {
  it("returns a stt.partial packet with optional wordTimings", () => {
    const timings = [{ word: "hello", startMs: 100, endMs: 250, confidence: 0.9 }];
    expect(sttPartial("ctx-1", 1000, "hello world", timings)).toEqual({
      kind: "stt.partial",
      contextId: "ctx-1",
      timestampMs: 1000,
      text: "hello world",
      wordTimings: timings,
    });
    expect(sttPartial("ctx-1", 1000, "hello")).toEqual({
      kind: "stt.partial",
      contextId: "ctx-1",
      timestampMs: 1000,
      text: "hello",
    });
  });
});

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

describe("injectMessage", () => {
  it("keeps speak as the omitted default and carries context mode when requested", () => {
    expect(injectMessage("ctx-1", 1000, "say this")).toEqual({
      kind: "inject.message",
      contextId: "ctx-1",
      timestampMs: 1000,
      text: "say this",
    });
    expect(injectMessage("ctx-1", 1000, "remember this", "context")).toEqual({
      kind: "inject.message",
      contextId: "ctx-1",
      timestampMs: 1000,
      text: "remember this",
      mode: "context",
    });
  });
});

describe("sttReconfigure", () => {
  it("returns an stt.reconfigure packet with the partial", () => {
    const partial = { keyterms: ["account number"], endpointingMs: 120 };
    expect(sttReconfigure("ctx-1", 1000, partial)).toEqual({
      kind: "stt.reconfigure",
      contextId: "ctx-1",
      timestampMs: 1000,
      partial,
    });
  });
});
