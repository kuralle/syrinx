// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import { PipelineBusImpl } from "../pipeline-bus.js";
import { RuleBasedInteractionPolicy, type RuleBasedInteractionPolicyDeps } from "./rule-based.js";
import { PrimarySpeakerGate } from "../primary-speaker-gate.js";
import { TtsPlayoutClock } from "../tts-playout-clock.js";

async function createPolicy(
  minInterruptionMs = 280,
  opts?: {
    pauseThenResolveBargeIn?: boolean;
    backchannel?: RuleBasedInteractionPolicyDeps["backchannel"];
  },
) {
  const bus = new PipelineBusImpl();
  void bus.start();
  const ttsPlayout = new TtsPlayoutClock();
  const policy = new RuleBasedInteractionPolicy({
    bus,
    primarySpeakerGate: new PrimarySpeakerGate(),
    ttsPlayout,
    minInterruptionMs,
    pauseThenResolveBargeIn: opts?.pauseThenResolveBargeIn,
    backchannel: opts?.backchannel,
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

  it("IP-C3: emits no backchannel on VAD/user-pause observations", async () => {
    const { policy } = await createPolicy();

    expect(
      policy.observe({
        kind: "vad_speech_ended",
        contextId: "user",
        timestampMs: 5000,
        hasActiveTts: false,
      }),
    ).toEqual([]);
    expect(
      policy.observe({
        kind: "vad_speech_activity",
        contextId: "user",
        timestampMs: 5100,
      }),
    ).toEqual([]);
  });

  it("IP-C3: emits exactly one cue on started → delayed and clears on complete", async () => {
    const { policy } = await createPolicy();

    policy.observe({
      kind: "delegate_state",
      contextId: "turn-1",
      timestampMs: 1000,
      toolCallPhase: "started",
    });
    expect(
      policy.observe({
        kind: "delegate_state",
        contextId: "turn-1",
        timestampMs: 3000,
        toolCallPhase: "delayed",
      }),
    ).toEqual([{ kind: "backchannel", cue: "mm_hmm" }]);
    expect(
      policy.observe({
        kind: "delegate_state",
        contextId: "turn-1",
        timestampMs: 3200,
        toolCallPhase: "delayed",
      }),
    ).toEqual([]);
    policy.observe({
      kind: "delegate_state",
      contextId: "turn-1",
      timestampMs: 4000,
      toolCallPhase: "complete",
    });
    policy.observe({
      kind: "delegate_state",
      contextId: "turn-1",
      timestampMs: 5000,
      toolCallPhase: "started",
    });
    expect(
      policy.observe({
        kind: "delegate_state",
        contextId: "turn-1",
        timestampMs: 7000,
        toolCallPhase: "delayed",
      }),
    ).toEqual([{ kind: "backchannel", cue: "mm_hmm" }]);
  });

  it("IP-C3: suppresses backchannel when TTS is active or the user is speaking", async () => {
    const { ttsPlayout, policy } = await createPolicy();
    ttsPlayout.noteAudio("assistant-turn", 500, 1000);

    policy.observe({
      kind: "delegate_state",
      contextId: "turn-1",
      timestampMs: 1000,
      toolCallPhase: "started",
    });
    expect(
      policy.observe({
        kind: "delegate_state",
        contextId: "turn-1",
        timestampMs: 3000,
        toolCallPhase: "delayed",
      }),
    ).toEqual([]);

    ttsPlayout.release("assistant-turn");
    policy.observe({
      kind: "delegate_state",
      contextId: "turn-2",
      timestampMs: 4000,
      toolCallPhase: "started",
    });
    policy.observe({
      kind: "vad_speech_started",
      contextId: "user",
      timestampMs: 4100,
      confidence: 0.9,
      interruptedContextId: "",
    });
    expect(
      policy.observe({
        kind: "delegate_state",
        contextId: "turn-2",
        timestampMs: 6000,
        toolCallPhase: "delayed",
      }),
    ).toEqual([]);
  });

  it("IP-C3: reset clears delegate-gap backchannel state", async () => {
    const { policy } = await createPolicy();

    policy.observe({
      kind: "delegate_state",
      contextId: "turn-1",
      timestampMs: 1000,
      toolCallPhase: "started",
    });
    policy.reset("turn-1");
    expect(
      policy.observe({
        kind: "delegate_state",
        contextId: "turn-1",
        timestampMs: 3000,
        toolCallPhase: "delayed",
      }),
    ).toEqual([]);
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

  it("backchannel disabled returns empty decisions", async () => {
    const { policy } = await createPolicy(280, { backchannel: { enabled: false } });

    policy.observe({
      kind: "delegate_state",
      contextId: "turn-1",
      timestampMs: 1000,
      toolCallPhase: "started",
    });
    expect(
      policy.observe({
        kind: "delegate_state",
        contextId: "turn-1",
        timestampMs: 3000,
        toolCallPhase: "delayed",
      }),
    ).toEqual([]);
  });

  it("backchannel cue-set knob selects first cue", async () => {
    const { policy } = await createPolicy(280, { backchannel: { cues: ["uh_huh"] } });

    policy.observe({
      kind: "delegate_state",
      contextId: "turn-1",
      timestampMs: 1000,
      toolCallPhase: "started",
    });
    expect(
      policy.observe({
        kind: "delegate_state",
        contextId: "turn-1",
        timestampMs: 3000,
        toolCallPhase: "delayed",
      }),
    ).toEqual([{ kind: "backchannel", cue: "uh_huh" }]);
  });

  it("default backchannel cue is mm_hmm", async () => {
    const { policy } = await createPolicy();

    policy.observe({
      kind: "delegate_state",
      contextId: "turn-1",
      timestampMs: 1000,
      toolCallPhase: "started",
    });
    expect(
      policy.observe({
        kind: "delegate_state",
        contextId: "turn-1",
        timestampMs: 3000,
        toolCallPhase: "delayed",
      }),
    ).toEqual([{ kind: "backchannel", cue: "mm_hmm" }]);
  });
});