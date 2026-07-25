// SPDX-License-Identifier: MIT

import { buildSessionRecord } from "@kuralle-syrinx/browser-client/record";
import { describe, expect, it } from "vitest";

import { baseComponent, classifyErrorSeverity, collectAgentErrors } from "./agent-errors";

const recordFrom = (msgs: readonly unknown[]) =>
  buildSessionRecord(msgs.map((m, i) => ({ message: m as never, atMs: i })));

describe("baseComponent", () => {
  it("treats the wire's .error suffix as the same component", () => {
    expect(baseComponent("llm.error")).toBe("llm");
    expect(baseComponent("transport")).toBe("transport");
    expect(baseComponent(undefined)).toBeUndefined();
  });
});

describe("classifyErrorSeverity", () => {
  it("matches core's own recoverable set, and nothing more", () => {
    // error-handler.ts:117 — rate_limit and network_timeout, full stop.
    expect(classifyErrorSeverity("llm.error", "rate_limit")).toBe("recoverable");
    expect(classifyErrorSeverity("llm.error", "network_timeout")).toBe("recoverable");
  });

  it.each(["authentication", "invalid_input", "internal_fault", "resource_exhausted"])(
    "treats a provider %s error as fatal, because the session closes on it",
    (category) => {
      expect(classifyErrorSeverity("tts.error", category)).toBe("fatal");
    },
  );

  it("treats a pipeline handler fault as recoverable whatever its category", () => {
    // pipeline-bus.ts:361 marks these recoverable by design: one misbehaving
    // handler degrades a turn rather than killing the call.
    expect(classifyErrorSeverity("pipeline.error", "internal_fault")).toBe("recoverable");
  });

  it("separates a rejected message from a connection the server ended", () => {
    // server-websocket sends invalid_input and keeps going; the timeouts close.
    expect(classifyErrorSeverity("transport", "invalid_input")).toBe("recoverable");
    expect(classifyErrorSeverity("transport", "session_timeout")).toBe("fatal");
    expect(classifyErrorSeverity("transport", "idle_timeout")).toBe("fatal");
  });

  it("treats a failed startup as fatal", () => {
    expect(classifyErrorSeverity("session", "initialization")).toBe("fatal");
    expect(classifyErrorSeverity("session", "startup_timeout")).toBe("fatal");
  });

  it("admits it does not know rather than colouring a guess in", () => {
    expect(classifyErrorSeverity("llm.error", undefined)).toBe("unknown");
    expect(classifyErrorSeverity("llm.error", "brand_new_category")).toBe("unknown");
    expect(classifyErrorSeverity(undefined, undefined)).toBe("unknown");
    expect(classifyErrorSeverity("transport", "something_else")).toBe("unknown");
  });
});

describe("collectAgentErrors", () => {
  it("keeps an error tied to the turn it happened in", () => {
    const record = recordFrom([
      { type: "stt_output", turnId: "t1", transcript: "hello" },
      { type: "error", turnId: "t1", component: "llm.error", category: "rate_limit", message: "429" },
    ]);
    const errors = collectAgentErrors(record);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      turnId: "t1",
      component: "llm.error",
      category: "rate_limit",
      message: "429",
      severity: "recoverable",
    });
  });

  it("keeps an error that belongs to no turn", () => {
    // A startup failure arrives before any turn exists — reading only turns would
    // drop the single most important error there is.
    const record = recordFrom([
      { type: "error", component: "session", category: "initialization", message: "no key" },
    ]);
    const errors = collectAgentErrors(record);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.turnId).toBeUndefined();
    expect(errors[0]?.severity).toBe("fatal");
  });

  it("collects from turns and the session stream together, newest first", () => {
    const record = recordFrom([
      { type: "error", component: "transport", category: "invalid_input", message: "bad frame" },
      { type: "error", turnId: "t1", component: "llm.error", category: "rate_limit", message: "429" },
      { type: "error", turnId: "t1", component: "tts.error", category: "authentication", message: "401" },
    ]);
    const errors = collectAgentErrors(record);
    expect(errors.map((e) => e.message)).toEqual(["401", "429", "bad frame"]);
  });

  it("has nothing to report for a clean session", () => {
    expect(collectAgentErrors(recordFrom([{ type: "turn_complete", turnId: "t1", transcript: "hi" }]))).toEqual(
      [],
    );
  });
});
