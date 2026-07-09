// SPDX-License-Identifier: MIT

import { describe, it, expect, vi } from "vitest";
import { PipelineBusImpl } from "./pipeline-bus.js";
import { InteractionCoordinator } from "./interaction-coordinator.js";
import type { InteractionDecision, InteractionObservation, InteractionPolicy } from "./interaction-policy.js";
import { TurnArbiter } from "./turn-arbiter.js";
import { PrimarySpeakerGate } from "./primary-speaker-gate.js";
import { TtsPlayoutClock } from "./tts-playout-clock.js";
import type { InterruptionDetectedPacket } from "./packets.js";

class StubPolicy implements InteractionPolicy {
  constructor(private readonly decisions: InteractionDecision[]) {}

  observe(_obs: InteractionObservation): readonly InteractionDecision[] {
    return this.decisions;
  }

  reset(): void {}
}

async function createCoordinator(decisions: InteractionDecision[]) {
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
  });
  return { bus, coordinator, executor };
}

async function drainBus(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
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

  it("no-ops take_turn, backchannel, hold, and keep_listening in C1", async () => {
    const { bus, coordinator, executor } = await createCoordinator([
      { kind: "take_turn", confidence: 0.9 },
      { kind: "backchannel", cue: "yeah" },
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