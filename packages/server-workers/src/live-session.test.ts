// SPDX-License-Identifier: MIT

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { VoiceAgentSession } from "@kuralle-syrinx/core";
import { ReasoningBridge } from "@kuralle-syrinx/aisdk";
import { DeepgramSTTPlugin, DeepgramTTSPlugin } from "@kuralle-syrinx/deepgram";

import {
  createLiveVoiceAgentSession,
  hasLiveSessionCredentials,
} from "./live-session.js";

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const mockVectorize = {} as import("@cloudflare/workers-types").VectorizeIndex;

describe("createLiveVoiceAgentSession", () => {
  it("registers stt, kuralle bridge, and Deepgram TTS plugins", async () => {
    const registerSpy = vi.spyOn(VoiceAgentSession.prototype, "registerPlugin");
    const session = await createLiveVoiceAgentSession({
      DEEPGRAM_API_KEY: "dg-key",
      OPENAI_API_KEY: "oa-key",
      VECTORIZE: mockVectorize,
    });
    expect(session).toBeInstanceOf(VoiceAgentSession);
    expect(registerSpy).toHaveBeenCalledWith("stt", expect.any(DeepgramSTTPlugin));
    expect(registerSpy).toHaveBeenCalledWith("bridge", expect.any(ReasoningBridge));
    expect(registerSpy).toHaveBeenCalledWith("tts", expect.any(DeepgramTTSPlugin));
    registerSpy.mockRestore();
  });

  it("requires DEEPGRAM_API_KEY, OPENAI_API_KEY, and VECTORIZE", async () => {
    await expect(createLiveVoiceAgentSession({
      OPENAI_API_KEY: "k",
      VECTORIZE: mockVectorize,
    })).rejects.toThrow(/DEEPGRAM_API_KEY/);
    await expect(createLiveVoiceAgentSession({
      DEEPGRAM_API_KEY: "k",
      VECTORIZE: mockVectorize,
    })).rejects.toThrow(/OPENAI_API_KEY/);
    await expect(createLiveVoiceAgentSession({
      DEEPGRAM_API_KEY: "k",
      OPENAI_API_KEY: "k",
      VECTORIZE: undefined as unknown as typeof mockVectorize,
    })).rejects.toThrow(/VECTORIZE/);
  });

  it("reports credential presence via hasLiveSessionCredentials", () => {
    expect(hasLiveSessionCredentials({
      DEEPGRAM_API_KEY: "d",
      OPENAI_API_KEY: "o",
      VECTORIZE: mockVectorize,
    })).toBe(true);
    expect(hasLiveSessionCredentials({
      OPENAI_API_KEY: "o",
      VECTORIZE: mockVectorize,
    })).toBe(false);
  });
});

describe("cascade worker edge safety", () => {
  it("live-session and worker stay free of Node-only primitives", () => {
    const files = ["live-session.ts", "worker.ts", "kuralle-realtime-agent.ts"];
    const banned = /\bBuffer\b|from "node:|process\./;
    for (const file of files) {
      const source = readFileSync(path.join(srcDir, file), "utf8");
      for (const [index, line] of source.split("\n").entries()) {
        expect(line, `${file}:${index + 1}`).not.toMatch(banned);
      }
    }
  });

  it("does not pull node: imports into the cascade worker src tree", () => {
    const nodeImports = readdirSync(srcDir)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .flatMap((name) => {
        const source = readFileSync(path.join(srcDir, name), "utf8");
        return source
          .split("\n")
          .filter((line) => line.includes('from "node:'))
          .map((line) => `${name}: ${line.trim()}`);
      });
    expect(nodeImports.filter((entry) => entry.startsWith("live-session")
      || entry.startsWith("worker.ts")
      || entry.startsWith("kuralle-realtime-agent"))).toEqual([]);
  });
});
