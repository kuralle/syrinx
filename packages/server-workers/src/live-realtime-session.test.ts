// SPDX-License-Identifier: MIT

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  hasRealtimeSessionCredentials,
  realtimeVoicePipeline,
  resolveRealtimeFront,
} from "./live-realtime-session.js";

const srcDir = path.dirname(fileURLToPath(import.meta.url));

const mockVectorize = {} as import("@cloudflare/workers-types").VectorizeIndex;
const ctx = { sessionId: "s1" };

describe("realtimeVoicePipeline", () => {
  it("is a realtime pipeline routed through the ask_university delegate tool", () => {
    expect(realtimeVoicePipeline.kind).toBe("realtime");
    expect(realtimeVoicePipeline.delegateToolName).toBe("ask_university");
  });

  it("builds an OpenAI front by default and a Gemini front when REALTIME_FRONT=gemini", () => {
    const openai = realtimeVoicePipeline.front({ OPENAI_API_KEY: "k", VECTORIZE: mockVectorize }, ctx);
    expect(openai).toBeTruthy();
    const gemini = realtimeVoicePipeline.front(
      { REALTIME_FRONT: "gemini", GEMINI_API_KEY: "g", VECTORIZE: mockVectorize },
      ctx,
    );
    expect(gemini).toBeTruthy();
  });

  it("requires the front model's key (OPENAI_API_KEY default; GEMINI_API_KEY for gemini)", () => {
    expect(() => realtimeVoicePipeline.front({ VECTORIZE: mockVectorize }, ctx)).toThrow(/OPENAI_API_KEY/);
    expect(() =>
      realtimeVoicePipeline.front({ REALTIME_FRONT: "gemini", VECTORIZE: mockVectorize }, ctx),
    ).toThrow(/GEMINI_API_KEY/);
  });

  it("reports credential presence via hasRealtimeSessionCredentials", () => {
    expect(hasRealtimeSessionCredentials({ OPENAI_API_KEY: "k", VECTORIZE: mockVectorize })).toBe(true);
    expect(hasRealtimeSessionCredentials({ VECTORIZE: mockVectorize })).toBe(false);
    expect(hasRealtimeSessionCredentials({
      REALTIME_FRONT: "gemini",
      GEMINI_API_KEY: "g",
      VECTORIZE: mockVectorize,
    })).toBe(true);
    expect(hasRealtimeSessionCredentials({
      REALTIME_FRONT: "gemini",
      VECTORIZE: mockVectorize,
    })).toBe(false);
  });

  it("defaults REALTIME_FRONT to openai", () => {
    expect(resolveRealtimeFront({ VECTORIZE: mockVectorize })).toBe("openai");
    expect(resolveRealtimeFront({ REALTIME_FRONT: "gemini", VECTORIZE: mockVectorize })).toBe("gemini");
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
