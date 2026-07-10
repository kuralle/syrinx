// SPDX-License-Identifier: MIT

import { describe, it, expect, vi } from "vitest";
import { PipelineBusImpl, Route } from "./pipeline-bus.js";
import { InteractionCoordinator } from "./interaction-coordinator.js";
import type { InteractionDecision, InteractionObservation, InteractionPolicy } from "./interaction-policy.js";
import { TurnArbiter } from "./turn-arbiter.js";
import { PrimarySpeakerGate } from "./primary-speaker-gate.js";
import { TtsPlayoutClock } from "./tts-playout-clock.js";
import { TimerScheduler } from "./scheduler.js";
import type { EndOfSpeechPacket, InteractionBackchannelPacket, InterruptionDetectedPacket } from "./packets.js";

class StubPolicy implements InteractionPolicy {
  constructor(private readonly decisions: InteractionDecision[]) {}

  observe(_obs: InteractionObservation): readonly InteractionDecision[] {
    return this.decisions;
  }

  reset(): void {}
}

class StatefulPolicy implements InteractionPolicy {
  private step = 0;

  constructor(private readonly steps: Array<readonly InteractionDecision[]>) {}

  observe(_obs: InteractionObservation): readonly InteractionDecision[] {
    const out = this.steps[this.step] ?? [];
    this.step += 1;
    return out;
  }

  reset(): void {
    this.step = 0;
  }
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
    scheduler: new TimerScheduler(),
    caps: { emitsBackchannel: options.emitsBackchannel },
    isUserSpeaking: options.isUserSpeaking,
    isTtsActive: options.isTtsActive,
    hasCueAsset: options.hasCueAsset,
  });
  coordinator.initialize();
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

  it("maps take_turn to stt.finalize and a delayed eos.turn_complete", async () => {
    vi.useFakeTimers();
    const { bus, coordinator } = await createCoordinator([{ kind: "take_turn", confidence: 1 }]);
    const finalizeRequests: string[] = [];
    const completions: Array<{ contextId: string; text: string }> = [];
    bus.on("stt.finalize", (pkt) => {
      finalizeRequests.push(pkt.contextId);
    });
    bus.on("eos.turn_complete", (pkt) => {
      const eos = pkt as EndOfSpeechPacket;
      completions.push({ contextId: eos.contextId, text: eos.text });
    });

    coordinator.observe({
      kind: "vad_speech_ended",
      contextId: "turn-1",
      timestampMs: 1000,
      hasActiveTts: false,
    });
    bus.push(Route.Main, {
      kind: "stt.result",
      contextId: "turn-1",
      timestampMs: 1100,
      text: "hello there",
      confidence: 0.95,
      language: "en-US",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(finalizeRequests).toEqual(["turn-1"]);
    expect(completions).toEqual([]);

    await vi.advanceTimersByTimeAsync(149);
    expect(completions).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(completions).toEqual([{ contextId: "turn-1", text: "hello there" }]);
    vi.useRealTimers();
  });

  it("uses a transcript that arrived before take_turn and requests STT finalization only once", async () => {
    vi.useFakeTimers();
    const { bus, coordinator } = await createCoordinator([{ kind: "take_turn", confidence: 1 }]);
    const finalizeRequests: string[] = [];
    const completions: EndOfSpeechPacket[] = [];
    bus.on("stt.finalize", (pkt) => {
      finalizeRequests.push(pkt.contextId);
    });
    bus.on("eos.turn_complete", (pkt) => {
      completions.push(pkt as EndOfSpeechPacket);
    });

    bus.push(Route.Main, {
      kind: "stt.result",
      contextId: "turn-cached",
      timestampMs: 900,
      text: "already final",
      confidence: 0.95,
      language: "en-US",
    });
    await vi.advanceTimersByTimeAsync(0);
    const observation = {
      kind: "audio_frame" as const,
      contextId: "turn-cached",
      timestampMs: 1000,
      audio: new Int16Array(320),
    };
    coordinator.observe(observation);
    coordinator.observe(observation);

    await vi.advanceTimersByTimeAsync(0);
    expect(finalizeRequests).toEqual(["turn-cached"]);
    await vi.advanceTimersByTimeAsync(150);
    expect(completions).toEqual([
      expect.objectContaining({ contextId: "turn-cached", text: "already final" }),
    ]);
    vi.useRealTimers();
  });

  it("revokes a pending take_turn on hold", async () => {
    vi.useFakeTimers();
    const bus = new PipelineBusImpl();
    void bus.start();
    const coordinator = new InteractionCoordinator({
      bus,
      policy: new StatefulPolicy([
        [{ kind: "take_turn", confidence: 0.2 }],
        [{ kind: "hold" }],
      ]),
      executor: new TurnArbiter({
        bus,
        primarySpeakerGate: new PrimarySpeakerGate(),
        ttsPlayout: new TtsPlayoutClock(),
        minInterruptionMs: 280,
      }),
      scheduler: new TimerScheduler(),
      caps: {},
    });
    coordinator.initialize();

    const completions: string[] = [];
    bus.on("eos.turn_complete", (pkt) => {
      completions.push(pkt.contextId);
    });

    coordinator.observe({
      kind: "vad_speech_ended",
      contextId: "turn-hold",
      timestampMs: 1000,
      hasActiveTts: false,
    });
    bus.push(Route.Main, {
      kind: "stt.result",
      contextId: "turn-hold",
      timestampMs: 1100,
      text: "wait",
      confidence: 0.9,
      language: "en-US",
    });
    await vi.advanceTimersByTimeAsync(0);
    coordinator.observe({
      kind: "vad_speech_activity",
      contextId: "turn-hold",
      timestampMs: 1200,
    });

    await vi.advanceTimersByTimeAsync(5000);
    expect(completions).toEqual([]);
    vi.useRealTimers();
  });

  it("revokes a pending take_turn when speech resumes", async () => {
    vi.useFakeTimers();
    const { bus, coordinator } = await createCoordinator([{ kind: "take_turn", confidence: 0.5 }]);
    const completions: string[] = [];
    bus.on("eos.turn_complete", (pkt) => {
      completions.push(pkt.contextId);
    });

    coordinator.observe({
      kind: "vad_speech_ended",
      contextId: "turn-resume",
      timestampMs: 1000,
      hasActiveTts: false,
    });
    bus.push(Route.Main, {
      kind: "stt.result",
      contextId: "turn-resume",
      timestampMs: 1100,
      text: "partial",
      confidence: 0.9,
      language: "en-US",
    });
    await vi.advanceTimersByTimeAsync(0);
    bus.push(Route.Main, {
      kind: "vad.speech_started",
      contextId: "turn-resume",
      timestampMs: 1200,
      confidence: 0.9,
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(completions).toEqual([]);
    vi.useRealTimers();
  });
});
