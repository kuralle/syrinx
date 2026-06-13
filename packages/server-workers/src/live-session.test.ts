// SPDX-License-Identifier: MIT

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DeepgramSTTPlugin, DeepgramTTSPlugin } from "@kuralle-syrinx/deepgram";

import {
  createLiveReasoner,
  hasLiveSessionCredentials,
  liveCascadedPipeline,
} from "./live-session.js";

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const mockVectorize = {} as import("@cloudflare/workers-types").VectorizeIndex;
const ctx = { sessionId: "s1" };

describe("liveCascadedPipeline", () => {
  it("is a provider-endpointed cascade with a tightened force-finalize timeout", () => {
    expect(liveCascadedPipeline.kind).toBe("cascaded");
    expect(liveCascadedPipeline.endpointingOwner).toBe("provider_stt");
    expect(liveCascadedPipeline.sttForceFinalizeTimeoutMs).toBe(3500);
  });

  it("builds Deepgram Nova-3 STT (VAD events) and Aura TTS stages from the env", () => {
    const env = { DEEPGRAM_API_KEY: "dg-key", OPENAI_API_KEY: "oa-key", VECTORIZE: mockVectorize };
    const stt = liveCascadedPipeline.stt(env, ctx);
    expect(stt.plugin).toBeInstanceOf(DeepgramSTTPlugin);
    expect(stt.config).toMatchObject({ model: "nova-3", endpointing: 300, vad_events: true, api_key: "dg-key" });

    const tts = liveCascadedPipeline.tts(env, ctx);
    expect(tts.plugin).toBeInstanceOf(DeepgramTTSPlugin);
    expect(tts.config).toMatchObject({ model: "aura-2-thalia-en", api_key: "dg-key" });
  });

  it("requires DEEPGRAM_API_KEY to build the stt/tts stages", () => {
    const env = { OPENAI_API_KEY: "k", VECTORIZE: mockVectorize };
    expect(() => liveCascadedPipeline.stt(env, ctx)).toThrow(/DEEPGRAM_API_KEY/);
    expect(() => liveCascadedPipeline.tts(env, ctx)).toThrow(/DEEPGRAM_API_KEY/);
  });
});

describe("createLiveReasoner", () => {
  it("requires OPENAI_API_KEY and VECTORIZE", async () => {
    await expect(createLiveReasoner({ VECTORIZE: mockVectorize }, ctx)).rejects.toThrow(/OPENAI_API_KEY/);
    await expect(
      createLiveReasoner(
        { OPENAI_API_KEY: "k", VECTORIZE: undefined as unknown as typeof mockVectorize },
        ctx,
      ),
    ).rejects.toThrow(/VECTORIZE/);
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
