// SPDX-License-Identifier: MIT

import { describe, it, expect, vi } from "vitest";
import { PipelineBusImpl } from "./pipeline-bus.js";
import { InteractionCoordinator } from "./interaction-coordinator.js";
import type { InteractionDecision, InteractionObservation, InteractionPolicy } from "./interaction-policy.js";
import { TurnArbiter } from "./turn-arbiter.js";
import { PrimarySpeakerGate } from "./primary-speaker-gate.js";
import { TtsPlayoutClock } from "./tts-playout-clock.js";
import type { InteractionBackchannelPacket, InterruptionDetectedPacket } from "./packets.js";

class StubPolicy implements InteractionPolicy {
  constructor(private readonly decisions: InteractionDecision[]) {}

  observe(_obs: InteractionObservation): readonly InteractionDecision[] {
    return this.decisions;
  }

  reset(): void {}
}

async function createCoordinator(
  decisions: InteractionDecision[],
  options: {
    emitsBackchannel?: boolean;
    isUserSpeaking?: () => boolean;
    isTtsActive?: () => boolean;
    hasCueAsset?: (cueId: string) => boolean;
  } = {},
) {
  const bus = new PipelineBusImpl();
  void bus.start();
  const ttsPlayout = new TtsPlayoutClock();
  const executor = new TurnArbiter({
    bus,
    primarySpeakerGate: new PrimarySpeakerGate(),
    ttsPlayout,
    minInterruptionMs: 280,
  });
  const coordinator = new InteractionCoordinator({
    bus,
    policy: new StubPolicy(decisions),
    executor,
    caps: { emitsBackchannel: options.emitsBackchannel },
    isUserSpeaking: options.isUserSpeaking,
    isTtsActive: options.isTtsActive,
    hasCueAsset: options.hasCueAsset,
  });
  return { bus, coordinator, executor };
}

async function drainBus(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function metricNames(bus: PipelineBusImpl): string[] {
  const names: string[] = [];
  bus.on("metric.conversation", (pkt) => {
    names.push((pkt as unknown as { name: string }).name);
  });
  return names;
}

describe("InteractionCoordinator", () => {
  it("maps interrupt decision to executor.emitInterruptDetected", async () => {
    const { bus, coordinator, executor } = await createCoordinator([
      { kind: "interrupt", interruptedContextId: "assistant-turn" },
    ]);
    const interrupts: InterruptionDetectedPacket[] = [];
    bus.on("interrupt.detected", (pkt) => {
      interrupts.push(pkt as InterruptionDetectedPacket);
    });
    const emitSpy = vi.spyOn(executor, "emitInterruptDetected");

    coordinator.observe({
      kind: "vad_speech_activity",
      contextId: "user",
      timestampMs: 1000,
    });
    await drainBus();

    expect(emitSpy).toHaveBeenCalledOnce();
    expect(emitSpy).toHaveBeenCalledWith("assistant-turn");
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0]!.contextId).toBe("assistant-turn");
  });

  it("emits interaction.backchannel for a backchannel decision", async () => {
    const { bus, coordinator } = await createCoordinator([{ kind: "backchannel", cue: "mm_hmm" }]);
    const packets: InteractionBackchannelPacket[] = [];
    const metrics = metricNames(bus);
    bus.on("interaction.backchannel", (pkt) => {
      packets.push(pkt as InteractionBackchannelPacket);
    });

    coordinator.observe({
      kind: "delegate_state",
      contextId: "turn-1",
      timestampMs: 2000,
      toolCallPhase: "delayed",
    });
    await drainBus();

    expect(packets).toHaveLength(1);
    expect(packets[0]).toMatchObject({ contextId: "turn-1", cue: "mm_hmm" });
    expect(metrics).toContain("backchannel.candidate");
    expect(metrics).toContain("backchannel.emitted");
  });

  it("suppresses backchannel when caps.emitsBackchannel is true", async () => {
    const { bus, coordinator } = await createCoordinator(
      [{ kind: "backchannel", cue: "mm_hmm" }],
      { emitsBackchannel: true },
    );
    const packets: InteractionBackchannelPacket[] = [];
    const metrics = metricNames(bus);
    bus.on("interaction.backchannel", (pkt) => {
      packets.push(pkt as InteractionBackchannelPacket);
    });

    coordinator.observe({
      kind: "delegate_state",
      contextId: "turn-1",
      timestampMs: 2000,
      toolCallPhase: "delayed",
    });
    await drainBus();

    expect(packets).toEqual([]);
    expect(metrics).toContain("backchannel.suppressed_caps");
  });

  it("suppresses backchannel when TTS is active", async () => {
    const { bus, coordinator } = await createCoordinator(
      [{ kind: "backchannel", cue: "mm_hmm" }],
      { isTtsActive: () => true },
    );
    const metrics = metricNames(bus);

    coordinator.observe({
      kind: "delegate_state",
      contextId: "turn-1",
      timestampMs: 2000,
      toolCallPhase: "delayed",
    });
    await drainBus();

    expect(metrics).toContain("backchannel.suppressed_tts_active");
  });

  it("suppresses backchannel when the user is speaking", async () => {
    const { bus, coordinator } = await createCoordinator(
      [{ kind: "backchannel", cue: "mm_hmm" }],
      { isUserSpeaking: () => true },
    );
    const metrics = metricNames(bus);

    coordinator.observe({
      kind: "delegate_state",
      contextId: "turn-1",
      timestampMs: 2000,
      toolCallPhase: "delayed",
    });
    await drainBus();

    expect(metrics).toContain("backchannel.suppressed_user_speaking");
  });

  it("suppresses backchannel when the cue asset is missing", async () => {
    const { bus, coordinator } = await createCoordinator(
      [{ kind: "backchannel", cue: "mm_hmm" }],
      { hasCueAsset: () => false },
    );
    const metrics = metricNames(bus);

    coordinator.observe({
      kind: "delegate_state",
      contextId: "turn-1",
      timestampMs: 2000,
      toolCallPhase: "delayed",
    });
    await drainBus();

    expect(metrics).toContain("backchannel.suppressed_missing_asset");
  });

  it("no-ops take_turn, hold, and keep_listening in C1", async () => {
    const { bus, coordinator, executor } = await createCoordinator([
      { kind: "take_turn", confidence: 0.9 },
      { kind: "hold" },
      { kind: "keep_listening" },
    ]);
    const emitSpy = vi.spyOn(executor, "emitInterruptDetected");
    const packets: unknown[] = [];
    bus.on("interrupt.detected", (pkt) => {
      packets.push(pkt);
    });
    bus.on("metric.conversation", (pkt) => {
      packets.push(pkt);
    });
    bus.on("interaction.backchannel", (pkt) => {
      packets.push(pkt);
    });

    coordinator.observe({
      kind: "vad_speech_activity",
      contextId: "user",
      timestampMs: 1000,
    });
    await drainBus();

    expect(emitSpy).not.toHaveBeenCalled();
    expect(packets).toEqual([]);
  });
});