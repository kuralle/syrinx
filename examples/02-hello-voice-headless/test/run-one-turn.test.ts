// SPDX-License-Identifier: MIT

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FakeBridge, FakeSTT, FakeTTS, FakeVAD } from "@asyncdot/voice-test";
import { describe, expect, it } from "vitest";

import {
  coerceGoogleGenAiKey,
  ensureRepoRootDotenv,
  listMissingVoiceHeadlessEnvKeys,
  runOneTurn,
} from "../src/run-one-turn.js";

function mkWideVadScript(): number[] {
  return [...Array.from({ length: 48 }, (): number => 0.95), ...Array.from({ length: 12_000 }, (): number => 0.02)];
}

describe("runOneTurn (contract, fakes)", () => {
  it(
    "returns TurnResult-shaped output without live providers",
    async () => {
      const userLine = "Hi, what's the weather like today?";
      const f1 = {
        data: new Int16Array(320),
        sampleRateHz: 16000,
        durationMs: 20,
      };
      const pcm = new Int16Array(320 * 80);
      pcm.fill(100);

      const root = await mkdtemp(join(tmpdir(), "vmt-hvh-"));

      try {
        const sessionDir = join(root, "session-a");

        const result = await runOneTurn({
          inputWavPath: join(root, "unused.wav"),
          sessionDir,
          sessionOverrides: {
            plugins: {
              vad: new FakeVAD(),
              stt: new FakeSTT(),
              bridge: new FakeBridge(),
              tts: new FakeTTS(),
            },
            pluginConfig: {
              vad: { scriptedSpeechProbabilities: mkWideVadScript() },
              stt: {
                scriptedEvents: [
                  {
                    kind: "final",
                    text: userLine,
                    confidence: 0.99,
                    ts: Date.now(),
                  },
                ],
              },
              bridge: {
                scriptedEvents: [
                  { kind: "text", delta: "It is seventy degrees." },
                  { kind: "done" },
                ],
              },
              tts: {
                scriptedAudioBatches: [{ frame: f1, final: true }],
              },
            },
            sttForceFinalizeTimeoutMs: 0,
          },
          syntheticMono16kSamples: pcm,
        });

        expect(result.sessionDir).toBe(sessionDir);
        expect(result.finalTranscript).toBe(userLine);
        expect(result.agentReply.replace(/\s/g, "").length).toBeGreaterThan(0);
        expect(result.agentOutWavPath.endsWith("audio-out.wav")).toBe(true);
        expect(result.inputWavPath.endsWith("audio-in.wav")).toBe(true);
        expect(result.eventsJsonlPath.endsWith("events.jsonl")).toBe(true);
        expect(result.transcriptJsonPath.endsWith("transcript.json")).toBe(true);
        expect(result.metricsJsonPath.endsWith("metrics.json")).toBe(true);
        expect(Number.isFinite(result.durationMs)).toBe(true);
        expect(typeof result.metrics.turnId).toBe("string");

        const transcriptJson = await readFile(result.transcriptJsonPath, "utf8");
        const parsed = JSON.parse(transcriptJson) as { readonly finalTranscript: string };
        expect(parsed.finalTranscript).toBe(userLine);
      } finally {
        await rmTree(root).catch(() => {});
      }
    },
    25_000,
  );
});

describe.runIf(process.env["RUN_LIVE"] === "1")("runOneTurn LIVE", () => {
  it(
    "runs the bundled fixture end-to-end with real keys",
    async () => {
      const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

      ensureRepoRootDotenv();
      coerceGoogleGenAiKey();
      const missing = listMissingVoiceHeadlessEnvKeys();
      expect(missing, `missing env for RUN_LIVE=1 (${missing.join(", ")})`).toStrictEqual([]);

      const fixturePath = join(pkgRoot, "public", "fixtures", "hello.wav");
      const outRoot = await mkdtemp(join(tmpdir(), "vmt-hvh-live-"));

      try {
        const sessionDir = join(outRoot, "sess");
        const r = await runOneTurn({
          inputWavPath: fixturePath,
          sessionDir,
        });
        expect(r.finalTranscript.trim().length).toBeGreaterThan(0);
        expect(r.agentReply.trim().length).toBeGreaterThan(0);

        const outWavStat = await readFile(r.agentOutWavPath).then((b) => b.byteLength);
        expect(outWavStat).toBeGreaterThan(1000);
      } finally {
        await rmTree(outRoot).catch(() => {});
      }
    },
    280_000,
  );
});

async function rmTree(p: string): Promise<void> {
  await import("node:fs/promises").then((m) =>
    m.rm(p, {
      recursive: true,
      maxRetries: 3,
      force: true,
    }),
  );
}
