// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import { PipelineBusImpl } from "../pipeline-bus.js";
import { RuleBasedInteractionPolicy } from "./rule-based.js";
import { PrimarySpeakerGate } from "../primary-speaker-gate.js";
import { TtsPlayoutClock } from "../tts-playout-clock.js";

async function createPolicy(minInterruptionMs = 280) {
  const bus = new PipelineBusImpl();
  void bus.start();
  const ttsPlayout = new TtsPlayoutClock();
  const policy = new RuleBasedInteractionPolicy({
    bus,
    primarySpeakerGate: new PrimarySpeakerGate(),
    ttsPlayout,
    minInterruptionMs,
  });
  return { bus, ttsPlayout, policy };
}

function metricNames(bus: PipelineBusImpl): string[] {
  const names: string[] = [];
  bus.on("metric.conversation", (pkt) => {
    names.push((pkt as unknown as { name: string }).name);
  });
  return names;
}

async function drainBus(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("RuleBasedInteractionPolicy", () => {
  it("parity vector: sustained speech commits interrupt at activity frame", async () => {
    const { ttsPlayout, policy } = await createPolicy(280);
    ttsPlayout.noteAudio("assistant-turn", 100, 1000);

    const t0 = 2000;
    expect(
      policy.observe({
        kind: "vad_speech_started",
        contextId: "user",
        timestampMs: t0,
        confidence: 0.99,
        interruptedContextId: "assistant-turn",
      }),
    ).toEqual([]);

    expect(
      policy.observe({
        kind: "vad_speech_activity",
        contextId: "user",
        timestampMs: t0 + 300,
      }),
    ).toEqual([{ kind: "interrupt", interruptedContextId: "assistant-turn" }]);
  });

  it("suppresses short speech blip without interrupt decision", async () => {
    const { bus, ttsPlayout, policy } = await createPolicy(280);
    const metrics = metricNames(bus);
    ttsPlayout.noteAudio("assistant-turn", 100, 1000);

    const t0 = 3000;
    policy.observe({
      kind: "vad_speech_started",
      contextId: "user",
      timestampMs: t0,
      confidence: 0.99,
      interruptedContextId: "assistant-turn",
    });
    policy.observe({
      kind: "vad_speech_activity",
      contextId: "user",
      timestampMs: t0 + 90,
    });
    const decisions = policy.observe({
      kind: "vad_speech_ended",
      contextId: "user",
      timestampMs: t0 + 130,
      hasActiveTts: true,
    });
    await drainBus();

    expect(decisions).toEqual([]);
    expect(metrics).toContain("interrupt.suppressed_short_speech");
  });

  it("suppresses backchannel interim without interrupt decision", async () => {
    const { bus, ttsPlayout, policy } = await createPolicy(280);
    const metrics = metricNames(bus);
    ttsPlayout.noteAudio("assistant-turn", 100, 1000);

    policy.observe({
      kind: "vad_speech_started",
      contextId: "user",
      timestampMs: 2000,
      confidence: 0.99,
      interruptedContextId: "assistant-turn",
    });
    policy.observe({
      kind: "stt_partial",
      contextId: "user",
      timestampMs: 2050,
      text: "uh huh",
    });
    const decisions = policy.observe({
      kind: "vad_speech_activity",
      contextId: "user",
      timestampMs: 2300,
    });
    await drainBus();

    expect(decisions).toEqual([]);
    expect(metrics).toContain("interrupt.suppressed_backchannel");
  });

  it("reset clears pending state", async () => {
    const { ttsPlayout, policy } = await createPolicy(280);
    ttsPlayout.noteAudio("assistant-turn", 100, 1000);

    const t0 = 4000;
    policy.observe({
      kind: "vad_speech_started",
      contextId: "user",
      timestampMs: t0,
      confidence: 0.99,
      interruptedContextId: "assistant-turn",
    });
    policy.reset("user");

    const decisions = policy.observe({
      kind: "vad_speech_activity",
      contextId: "user",
      timestampMs: t0 + 300,
    });
    expect(decisions).toEqual([]);
  });
});