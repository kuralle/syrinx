// SPDX-License-Identifier: MIT
//
// Kernel v2 baseline: repeated headless turns over the packet bus.
// This intentionally uses v2 plugins/configs directly; no v1 audioIn/audioOut shims.

import { mkdtemp, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeBridge, FakeSTT, FakeTTS, FakeVAD } from "@asyncdot/voice-test";
import { describe, expect, it } from "vitest";

import { runOneTurn, type PerTurnMetrics } from "../../src/run-one-turn.js";

interface ScriptedTurn {
  readonly transcript: string;
  readonly reply: string;
}

const SCRIPTED_CONVERSATION: readonly ScriptedTurn[] = [
  {
    transcript: "Hi, I'd like to order a sandwich please.",
    reply: "Sure. What kind of sandwich would you like?",
  },
  {
    transcript: "Can I get turkey with swiss cheese?",
    reply: "Turkey with swiss. Any toppings?",
  },
  {
    transcript: "Actually, make that provolone instead of swiss.",
    reply: "Provolone instead of swiss. Anything else?",
  },
];

function mkVadScript(): number[] {
  return [
    ...Array.from({ length: 10 }, () => 0.02),
    ...Array.from({ length: 80 }, () => 0.95),
    ...Array.from({ length: 120 }, () => 0.02),
  ];
}

function makePcm(): Int16Array {
  const pcm = new Int16Array(320 * 80);
  pcm.fill(100);
  return pcm;
}

function fakeSessionOptions(turn: ScriptedTurn) {
  return {
    plugins: {
      vad: new FakeVAD(),
      stt: new FakeSTT(),
      bridge: new FakeBridge(),
      tts: new FakeTTS(),
    },
    pluginConfig: {
      vad: { scriptedSpeechProbabilities: mkVadScript() },
      stt: {
        scriptedEvents: [
          {
            kind: "final",
            text: turn.transcript,
            confidence: 0.99,
            ts: Date.now(),
          },
        ],
      },
      bridge: {
        scriptedEvents: [
          { kind: "text", delta: turn.reply },
          { kind: "done" },
        ],
      },
      tts: {
        scriptedAudioBatches: [
          {
            frame: {
              data: new Int16Array(320),
              sampleRateHz: 16000,
              durationMs: 20,
            },
            final: true,
          },
        ],
      },
    },
    sttForceFinalizeTimeoutMs: 0,
  };
}

describe("packet-bus multi-turn baseline", () => {
  it("runs repeated turns through the v2 headless harness", async () => {
    const root = await mkdtemp(join(tmpdir(), "vmt-v2-baseline-"));
    const turns: PerTurnMetrics[] = [];

    for (let i = 0; i < SCRIPTED_CONVERSATION.length; i += 1) {
      const turn = SCRIPTED_CONVERSATION[i]!;
      const result = await runOneTurn({
        inputWavPath: join(root, "unused.wav"),
        sessionDir: join(root, `turn-${String(i)}`),
        sessionOverrides: fakeSessionOptions(turn),
        syntheticMono16kSamples: makePcm(),
      });

      expect(result.finalTranscript).toBe(turn.transcript);
      expect(result.agentReply).toContain(turn.reply);
      expect(result.metrics.e2eLatencyMs).toBeGreaterThanOrEqual(0);
      turns.push(result.metrics);
    }

    const avgE2E = turns.reduce((sum, turn) => sum + turn.e2eLatencyMs, 0) / turns.length;
    await writeFile(
      join(root, "baseline.json"),
      `${JSON.stringify({ kernelVersion: "v2", turnCount: turns.length, avgE2E, turns }, null, 2)}\n`,
      "utf8",
    );
  });

  it("keeps checked-in websocket baselines inside their quality gates", () => {
    const root = join(import.meta.dirname, "..", "..");
    const longform = JSON.parse(
      readFileSync(join(root, "test", "performance", "websocket-university-multiturn-baseline.json"), "utf8"),
    ) as { qualityGate?: { passed?: boolean }; turnCount?: number };
    const interactive = JSON.parse(
      readFileSync(join(root, "test", "performance", "websocket-university-interactive-baseline.json"), "utf8"),
    ) as {
      qualityGate?: { passed?: boolean };
      turnCount?: number;
      inputSampleRateHz?: number;
      outputSampleRateHz?: number;
      latencyMs?: { avgSttFinalAfterSpeechEnd?: number; avgTtsTimeToFirstAudio?: number };
    };

    expect(longform.qualityGate?.passed).toBe(true);
    expect(longform.turnCount).toBeGreaterThanOrEqual(24);
    expect(interactive.qualityGate?.passed).toBe(true);
    expect(interactive.turnCount).toBeGreaterThanOrEqual(3);
    expect(interactive.inputSampleRateHz).toBe(16000);
    expect(interactive.outputSampleRateHz).toBe(16000);
    expect(interactive.latencyMs?.avgSttFinalAfterSpeechEnd).toBeLessThanOrEqual(7000);
    expect(interactive.latencyMs?.avgTtsTimeToFirstAudio).toBeLessThanOrEqual(1000);
  });
});
