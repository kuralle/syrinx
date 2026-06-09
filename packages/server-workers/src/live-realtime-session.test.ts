// SPDX-License-Identifier: MIT

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { VoiceAgentSession } from "@kuralle-syrinx/core";
import { RealtimeBridge } from "@kuralle-syrinx/realtime";

import {
  createRealtimeVoiceAgentSession,
  hasRealtimeSessionCredentials,
} from "./live-realtime-session.js";

const srcDir = path.dirname(fileURLToPath(import.meta.url));

const mockVectorize = {} as import("@cloudflare/workers-types").VectorizeIndex;

describe("createRealtimeVoiceAgentSession", () => {
  it("registers the realtime plugin with RealtimeBridge", async () => {
    const registerSpy = vi.spyOn(VoiceAgentSession.prototype, "registerPlugin");
    const session = await createRealtimeVoiceAgentSession({
      OPENAI_API_KEY: "test-key",
      VECTORIZE: mockVectorize,
    });
    expect(session).toBeInstanceOf(VoiceAgentSession);
    expect(registerSpy).toHaveBeenCalledWith("realtime", expect.any(RealtimeBridge));
    registerSpy.mockRestore();
  });

  it("requires OPENAI_API_KEY", async () => {
    await expect(createRealtimeVoiceAgentSession({ VECTORIZE: mockVectorize })).rejects.toThrow(/OPENAI_API_KEY/);
  });

  it("reports credential presence via hasRealtimeSessionCredentials", () => {
    expect(hasRealtimeSessionCredentials({ OPENAI_API_KEY: "k", VECTORIZE: mockVectorize })).toBe(true);
    expect(hasRealtimeSessionCredentials({ VECTORIZE: mockVectorize })).toBe(false);
  });
});

describe("realtime worker edge safety", () => {
  it("live-realtime-session and worker-realtime stay free of Node-only primitives", () => {
    const files = ["live-realtime-session.ts", "worker-realtime.ts", "kuralle-realtime-agent.ts"];
    const banned = /\bBuffer\b|from "node:|process\./;
    for (const file of files) {
      const source = readFileSync(path.join(srcDir, file), "utf8");
      for (const [index, line] of source.split("\n").entries()) {
        expect(line, `${file}:${index + 1}`).not.toMatch(banned);
      }
    }
  });

  it("does not pull node: imports into the realtime worker src tree", () => {
    const nodeImports = readdirSync(srcDir)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .flatMap((name) => {
        const source = readFileSync(path.join(srcDir, name), "utf8");
        return source
          .split("\n")
          .filter((line) => line.includes('from "node:'))
          .map((line) => `${name}: ${line.trim()}`);
      });
    expect(nodeImports.filter((entry) => entry.startsWith("live-realtime-session")
      || entry.startsWith("worker-realtime")
      || entry.startsWith("kuralle-realtime-agent"))).toEqual([]);
  });
});
