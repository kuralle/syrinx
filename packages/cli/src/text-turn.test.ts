// SPDX-License-Identifier: MIT

import { VoiceAgentSession } from "@kuralle-syrinx/core";
import { FakeBridge, type FakeBridgeConfig } from "@kuralle-syrinx/test";
import { describe, expect, it } from "vitest";

import { CliError, EXIT_CODES } from "./exit-codes.js";
import { driveText } from "./text-turn.js";

function buildBridgeOnlySession(scriptedEvents: FakeBridgeConfig["scriptedEvents"]): VoiceAgentSession {
  const session = new VoiceAgentSession({ plugins: { bridge: { scriptedEvents } } });
  session.registerPlugin("bridge", new FakeBridge());
  return session;
}

describe("driveText", () => {
  it("returns the concatenated reply and a ttft from the first delta (no live provider)", async () => {
    const session = buildBridgeOnlySession([{ kind: "text", delta: "It is " }, { kind: "text", delta: "seventy degrees." }, { kind: "done" }]);
    const result = await driveText({ session, message: "what's the weather?" });
    expect(result.reply).toBe("It is seventy degrees.");
    expect(result.toolCalls).toBe(0);
    expect(result.totalMs).toBeGreaterThanOrEqual(0);
  });

  it("counts tool-call parts", async () => {
    const session = buildBridgeOnlySession([
      { kind: "tool_call", id: "1", name: "lookup", args: {} },
      { kind: "text", delta: "done" },
      { kind: "done" },
    ]);
    const result = await driveText({ session, message: "hi" });
    expect(result.toolCalls).toBe(1);
    expect(result.reply).toBe("done");
  });

  it("accepts a zero-arg session factory (the --agent contract)", async () => {
    const factory = (): VoiceAgentSession => buildBridgeOnlySession([{ kind: "text", delta: "ok" }, { kind: "done" }]);
    const result = await driveText({ session: factory, message: "hi" });
    expect(result.reply).toBe("ok");
  });

  it("times out as a BACKEND CliError if the agent never finishes", async () => {
    // No "done" event scripted, and no text either — agent_finished never fires.
    const session = buildBridgeOnlySession([]);
    const err = await driveText({ session, message: "hi", timeoutMs: 50 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(EXIT_CODES.BACKEND);
  });
});
