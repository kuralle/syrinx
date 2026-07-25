// SPDX-License-Identifier: MIT
//
// Contract test for the provider-agnostic driver (LDT-20, revised): given an
// already-built VoiceAgentSession (here, wired from @kuralle-syrinx/test's
// scripted fakes, closed over via the onAudioFrame/onAudioFed hooks — the same
// mechanism examples/02-hello-voice-headless/src/run-one-turn.ts's own
// hardcoded-kernel wrapper uses), driveTurn feeds it audio and reports the
// TurnResult shape correctly, with no live provider network.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VoiceAgentSession } from "@kuralle-syrinx/core";
import { FakeBridge, FakeSTT, FakeTTS, FakeVAD } from "@kuralle-syrinx/test";
import { describe, expect, it } from "vitest";

import { driveTurn } from "./turn-runner.js";

function mkWideVadScript(): number[] {
  return [...Array.from({ length: 48 }, (): number => 0.95), ...Array.from({ length: 12_000 }, (): number => 0.02)];
}

describe("driveTurn (contract, fakes)", () => {
  it(
    "returns TurnResult-shaped output without live providers, given an already-built session",
    async () => {
      const userLine = "Hi, what's the weather like today?";
      const f1 = { data: new Int16Array(320), sampleRateHz: 16000, durationMs: 20 };
      const pcm = new Int16Array(320 * 80);
      pcm.fill(100);

      const root = await mkdtemp(join(tmpdir(), "syrinx-cli-turn-"));
      try {
        const sessionDir = join(root, "session-a");

        const vad = new FakeVAD();
        const stt = new FakeSTT();
        const session = new VoiceAgentSession({
          plugins: {
            vad: { scriptedSpeechProbabilities: mkWideVadScript() },
            stt: { scriptedEvents: [{ kind: "final", text: userLine, confidence: 0.99, ts: Date.now() }] },
            bridge: { scriptedEvents: [{ kind: "text", delta: "It is seventy degrees." }, { kind: "done" }] },
            tts: { scriptedAudioBatches: [{ frame: f1, final: true }] },
          },
          sttForceFinalizeTimeoutMs: 0,
        });
        session.registerPlugin("vad", vad);
        session.registerPlugin("stt", stt);
        session.registerPlugin("bridge", new FakeBridge());
        session.registerPlugin("tts", new FakeTTS());

        const result = await driveTurn({
          session,
          inputWavPath: join(root, "unused.wav"),
          sessionDir,
          syntheticMono16kSamples: pcm,
          onAudioFrame: (contextId) => vad.processFrame(contextId),
          onAudioFed: (contextId) => stt.emitScripted(contextId),
        });

        expect(result.sessionDir).toBe(sessionDir);
        expect(result.finalTranscript).toBe(userLine);
        expect(result.agentReply.replace(/\s/g, "").length).toBeGreaterThan(0);
        expect(result.agentOutWavPath.endsWith("audio-out.wav")).toBe(true);
        expect(result.inputWavPath.endsWith("audio-in.wav")).toBe(true);
        expect(Number.isFinite(result.durationMs)).toBe(true);

        const transcriptJson = await readFile(result.transcriptJsonPath, "utf8");
        const parsed = JSON.parse(transcriptJson) as { readonly finalTranscript: string };
        expect(parsed.finalTranscript).toBe(userLine);
      } finally {
        await rm(root, { recursive: true, maxRetries: 3, force: true }).catch(() => {});
      }
    },
    25_000,
  );

  it("drives a session given as a zero-arg factory (the --agent contract), not just a pre-built instance", async () => {
    const pcm = new Int16Array(320 * 4);
    const root = await mkdtemp(join(tmpdir(), "syrinx-cli-turn-factory-"));
    try {
      const stt = new FakeSTT();
      const factory = () => {
        const session = new VoiceAgentSession({
          plugins: {
            stt: { scriptedEvents: [{ kind: "final", text: "hi", confidence: 0.9, ts: Date.now() }] },
            bridge: { scriptedEvents: [{ kind: "text", delta: "hello" }, { kind: "done" }] },
            tts: { scriptedAudioBatches: [{ frame: { data: new Int16Array(320), sampleRateHz: 16000, durationMs: 20 }, final: true }] },
          },
          sttForceFinalizeTimeoutMs: 0,
        });
        session.registerPlugin("stt", stt);
        session.registerPlugin("bridge", new FakeBridge());
        session.registerPlugin("tts", new FakeTTS());
        return session;
      };

      const result = await driveTurn({
        session: factory,
        inputWavPath: join(root, "unused.wav"),
        sessionDir: join(root, "session-b"),
        syntheticMono16kSamples: pcm,
        onAudioFed: (contextId) => stt.emitScripted(contextId),
      });
      expect(result.finalTranscript).toBe("hi");
    } finally {
      await rm(root, { recursive: true, maxRetries: 3, force: true }).catch(() => {});
    }
  });
});
