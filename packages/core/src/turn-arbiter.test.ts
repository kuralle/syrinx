// SPDX-License-Identifier: MIT

import { describe, it, expect, vi } from "vitest";
import { PipelineBusImpl, Route } from "./pipeline-bus.js";
import { TurnArbiter, isAcknowledgement } from "./turn-arbiter.js";
import { PrimarySpeakerGate } from "./primary-speaker-gate.js";
import { TtsPlayoutClock } from "./tts-playout-clock.js";
import type {
  InterruptionDetectedPacket,
  VadAudioPacket,
  VadSpeechActivityPacket,
  VadSpeechEndedPacket,
  VadSpeechStartedPacket,
} from "./packets.js";
import {
  BYSTANDER_SPEAKER_TONE_HZ,
  PRIMARY_SPEAKER_TONE_HZ,
  synthesizeTonePcm16,
} from "./primary-speaker-fixtures.js";

async function createArbiter(
  minInterruptionMs: number,
  gate = new PrimarySpeakerGate(),
  pauseThenResolveBargeIn?: boolean,
) {
  const bus = new PipelineBusImpl();
  void bus.start();
  const ttsPlayout = new TtsPlayoutClock();
  const arbiter = new TurnArbiter({
    bus,
    primarySpeakerGate: gate,
    ttsPlayout,
    minInterruptionMs,
    pauseThenResolveBargeIn,
  });
  return { bus, ttsPlayout, arbiter, gate };
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

describe("TurnArbiter", () => {
  it("commits sustained speech when playout is active", async () => {
    const { bus, ttsPlayout, arbiter } = await createArbiter(280);
    const metrics = metricNames(bus);
    const interrupts: InterruptionDetectedPacket[] = [];
    bus.on("interrupt.detected", (pkt) => {
      interrupts.push(pkt as InterruptionDetectedPacket);
    });

    ttsPlayout.noteAudio("assistant-turn", 100, 1000);
    arbiter.onSpeechStarted(
      {
        kind: "vad.speech_started",
        contextId: "user",
        timestampMs: 2000,
        confidence: 0.99,
      } satisfies VadSpeechStartedPacket,
      "assistant-turn",
    );
    arbiter.onSpeechActivity({
      kind: "vad.speech_activity",
      contextId: "user",
      timestampMs: 2300,
      isAsync: true,
    } satisfies VadSpeechActivityPacket);
    await drainBus();

    expect(interrupts).toHaveLength(1);
    expect(interrupts[0]!.contextId).toBe("assistant-turn");
    expect(metrics).toContain("interrupt.committed_after_ms");
    expect(metrics).toContain("vaqi.interruption");
    expect(metrics).toContain("interrupt.latency_ms");
  });

  it("suppresses short speech on speech_ended", async () => {
    const { bus, ttsPlayout, arbiter } = await createArbiter(280);
    const metrics = metricNames(bus);
    const interrupts: InterruptionDetectedPacket[] = [];
    bus.on("interrupt.detected", (pkt) => {
      interrupts.push(pkt as InterruptionDetectedPacket);
    });

    ttsPlayout.noteAudio("assistant-turn", 100, 1000);
    const t0 = 3000;
    arbiter.onSpeechStarted(
      {
        kind: "vad.speech_started",
        contextId: "user",
        timestampMs: t0,
        confidence: 0.99,
      } satisfies VadSpeechStartedPacket,
      "assistant-turn",
    );
    arbiter.onSpeechEnded(
      {
        kind: "vad.speech_ended",
        contextId: "user",
        timestampMs: t0 + 120,
      } satisfies VadSpeechEndedPacket,
      true,
    );
    await drainBus();

    expect(interrupts).toEqual([]);
    expect(metrics).toContain("interrupt.suppressed_short_speech");
  });

  it("emits gate_resolved_after_tts_end when playout finished", async () => {
    const { bus, ttsPlayout, arbiter } = await createArbiter(280);
    const metrics = metricNames(bus);

    ttsPlayout.noteAudio("assistant-turn", 50, 1000);
    ttsPlayout.scheduleRelease("assistant-turn", 1050);
    const t0 = 4000;
    arbiter.onSpeechStarted(
      {
        kind: "vad.speech_started",
        contextId: "user",
        timestampMs: t0,
        confidence: 0.99,
      } satisfies VadSpeechStartedPacket,
      "assistant-turn",
    );
    arbiter.onSpeechActivity({
      kind: "vad.speech_activity",
      contextId: "user",
      timestampMs: t0 + 300,
      isAsync: true,
    } satisfies VadSpeechActivityPacket);
    await drainBus();

    expect(metrics).toContain("interrupt.gate_resolved_after_tts_end");
  });

  it("defers minInterruptionMs 0 cut until barge-in audio when profile exists", async () => {
    const gate = new PrimarySpeakerGate();
    const { bus, ttsPlayout, arbiter } = await createArbiter(0, gate);
    const metrics = metricNames(bus);
    const interrupts: InterruptionDetectedPacket[] = [];
    bus.on("interrupt.detected", (pkt) => {
      interrupts.push(pkt as InterruptionDetectedPacket);
    });

    const enroll = synthesizeTonePcm16({ frequencyHz: PRIMARY_SPEAKER_TONE_HZ, durationMs: 32 });
    for (let i = 0; i < 12; i += 1) {
      gate.enrollUserTurnChunk(enroll);
    }
    gate.lockProfileFromFirstTurn();

    ttsPlayout.noteAudio("assistant-turn", 100, 5000);
    arbiter.onSpeechStarted(
      {
        kind: "vad.speech_started",
        contextId: "user",
        timestampMs: 6000,
        confidence: 0.99,
      } satisfies VadSpeechStartedPacket,
      "assistant-turn",
    );

    expect(interrupts).toEqual([]);
    expect(metrics).not.toContain("vaqi.interruption");

    const primary = synthesizeTonePcm16({ frequencyHz: PRIMARY_SPEAKER_TONE_HZ, durationMs: 32 });
    arbiter.observeBargeInAudio({
      kind: "vad.audio",
      contextId: "user",
      timestampMs: 6005,
      audio: primary,
    } satisfies VadAudioPacket);
    await drainBus();

    expect(interrupts).toHaveLength(1);
    expect(metrics).toContain("vaqi.interruption");
  });

  it("suppresses non-primary sustained barge-in", async () => {
    const gate = new PrimarySpeakerGate();
    const { bus, ttsPlayout, arbiter } = await createArbiter(280, gate);
    const metrics = metricNames(bus);

    const enroll = synthesizeTonePcm16({ frequencyHz: PRIMARY_SPEAKER_TONE_HZ, durationMs: 32 });
    for (let i = 0; i < 12; i += 1) {
      gate.enrollUserTurnChunk(enroll);
    }
    gate.lockProfileFromFirstTurn();

    ttsPlayout.noteAudio("assistant-turn", 100, 7000);
    const bystander = synthesizeTonePcm16({ frequencyHz: BYSTANDER_SPEAKER_TONE_HZ, durationMs: 32 });
    const t0 = 8000;
    arbiter.onSpeechStarted(
      {
        kind: "vad.speech_started",
        contextId: "user",
        timestampMs: t0,
        confidence: 0.99,
      } satisfies VadSpeechStartedPacket,
      "assistant-turn",
    );
    for (let i = 0; i < 8; i += 1) {
      arbiter.observeBargeInAudio({
        kind: "vad.audio",
        contextId: "user",
        timestampMs: t0 + 20 + i * 30,
        audio: bystander,
      } satisfies VadAudioPacket);
    }
    arbiter.onSpeechActivity({
      kind: "vad.speech_activity",
      contextId: "user",
      timestampMs: t0 + 320,
      isAsync: true,
    } satisfies VadSpeechActivityPacket);
    await drainBus();

    expect(metrics).toContain("interrupt.suppressed_non_primary");
  });

  it("recommits after non-primary suppression when primary speech continues", async () => {
    const gate = new PrimarySpeakerGate();
    const { bus, ttsPlayout, arbiter } = await createArbiter(280, gate);
    const metrics = metricNames(bus);
    const interrupts: InterruptionDetectedPacket[] = [];
    bus.on("interrupt.detected", (pkt) => {
      interrupts.push(pkt as InterruptionDetectedPacket);
    });

    const enroll = synthesizeTonePcm16({ frequencyHz: PRIMARY_SPEAKER_TONE_HZ, durationMs: 32 });
    for (let i = 0; i < 12; i += 1) {
      gate.enrollUserTurnChunk(enroll);
    }
    gate.lockProfileFromFirstTurn();

    ttsPlayout.noteAudio("assistant-turn", 100, 7000);
    const bystander = synthesizeTonePcm16({ frequencyHz: BYSTANDER_SPEAKER_TONE_HZ, durationMs: 32 });
    const primary = synthesizeTonePcm16({ frequencyHz: PRIMARY_SPEAKER_TONE_HZ, durationMs: 32 });
    const t0 = 9000;
    arbiter.onSpeechStarted(
      {
        kind: "vad.speech_started",
        contextId: "user",
        timestampMs: t0,
        confidence: 0.99,
      } satisfies VadSpeechStartedPacket,
      "assistant-turn",
    );
    for (let i = 0; i < 8; i += 1) {
      arbiter.observeBargeInAudio({
        kind: "vad.audio",
        contextId: "user",
        timestampMs: t0 + 20 + i * 30,
        audio: bystander,
      } satisfies VadAudioPacket);
    }
    arbiter.onSpeechActivity({
      kind: "vad.speech_activity",
      contextId: "user",
      timestampMs: t0 + 320,
      isAsync: true,
    } satisfies VadSpeechActivityPacket);
    await drainBus();
    expect(metrics).toContain("interrupt.suppressed_non_primary");
    expect(interrupts).toEqual([]);

    for (let i = 0; i < 6; i += 1) {
      arbiter.observeBargeInAudio({
        kind: "vad.audio",
        contextId: "user",
        timestampMs: t0 + 400 + i * 30,
        audio: primary,
      } satisfies VadAudioPacket);
    }
    arbiter.onSpeechActivity({
      kind: "vad.speech_activity",
      contextId: "user",
      timestampMs: t0 + 620,
      isAsync: true,
    } satisfies VadSpeechActivityPacket);
    await drainBus();

    expect(interrupts).toHaveLength(1);
    expect(metrics).toContain("interrupt.committed_after_ms");
  });

  it("suppresses backchannel interim at commit (test:backchannel_suppressed)", async () => {
    const { bus, ttsPlayout, arbiter } = await createArbiter(280);
    const metrics = metricNames(bus);
    const interrupts: InterruptionDetectedPacket[] = [];
    bus.on("interrupt.detected", (pkt) => {
      interrupts.push(pkt as InterruptionDetectedPacket);
    });

    ttsPlayout.noteAudio("assistant-turn", 100, 1000);
    // Realistic ordering: VAD detects onset first, then STT emits the interim for
    // this same utterance, then sustained activity drives the commit decision.
    arbiter.onSpeechStarted(
      {
        kind: "vad.speech_started",
        contextId: "user",
        timestampMs: 2000,
        confidence: 0.99,
      } satisfies VadSpeechStartedPacket,
      "assistant-turn",
    );
    arbiter.noteInterimEvidence("uh huh");
    arbiter.onSpeechActivity({
      kind: "vad.speech_activity",
      contextId: "user",
      timestampMs: 2300,
      isAsync: true,
    } satisfies VadSpeechActivityPacket);
    await drainBus();

    expect(interrupts).toEqual([]);
    expect(metrics).toContain("interrupt.suppressed_backchannel");
    expect(metrics).not.toContain("interrupt.committed_after_ms");
  });

  it("discards stale interim evidence from before the barge-in window (no false suppression)", async () => {
    const { bus, ttsPlayout, arbiter } = await createArbiter(280);
    const metrics = metricNames(bus);
    const interrupts: InterruptionDetectedPacket[] = [];
    bus.on("interrupt.detected", (pkt) => {
      interrupts.push(pkt as InterruptionDetectedPacket);
    });

    // A backchannel interim lands while no barge-in is pending (e.g. STT emits it
    // during a lull). It must NOT survive into the next, real barge-in's decision.
    arbiter.noteInterimEvidence("uh huh");

    ttsPlayout.noteAudio("assistant-turn", 100, 1000);
    arbiter.onSpeechStarted(
      {
        kind: "vad.speech_started",
        contextId: "user",
        timestampMs: 2000,
        confidence: 0.99,
      } satisfies VadSpeechStartedPacket,
      "assistant-turn",
    );
    // Sustained barge-in with no fresh interim for this turn: the stale "uh huh"
    // from before the window must have been cleared, so this commits.
    arbiter.onSpeechActivity({
      kind: "vad.speech_activity",
      contextId: "user",
      timestampMs: 2300,
      isAsync: true,
    } satisfies VadSpeechActivityPacket);
    await drainBus();

    expect(interrupts).toHaveLength(1);
    expect(metrics).toContain("interrupt.committed_after_ms");
    expect(metrics).not.toContain("interrupt.suppressed_backchannel");
  });

  it("suppresses low-confidence speech evidence with a distinct metric", async () => {
    const { bus, ttsPlayout, arbiter } = await createArbiter(280);
    const metrics = metricNames(bus);
    const interrupts: InterruptionDetectedPacket[] = [];
    bus.on("interrupt.detected", (pkt) => {
      interrupts.push(pkt as InterruptionDetectedPacket);
    });

    ttsPlayout.noteAudio("assistant-turn", 100, 1000);
    // Realistic ordering: onset first, then the low-confidence interim for this
    // utterance, then sustained activity reaching the commit decision.
    arbiter.onSpeechStarted(
      {
        kind: "vad.speech_started",
        contextId: "user",
        timestampMs: 2000,
        confidence: 0.99,
      } satisfies VadSpeechStartedPacket,
      "assistant-turn",
    );
    arbiter.noteInterimEvidence("I need help", 0.21);
    arbiter.onSpeechActivity({
      kind: "vad.speech_activity",
      contextId: "user",
      timestampMs: 2300,
      isAsync: true,
    } satisfies VadSpeechActivityPacket);
    await drainBus();

    expect(interrupts).toEqual([]);
    expect(metrics).toContain("interrupt.suppressed_low_confidence");
    expect(metrics).not.toContain("interrupt.committed_after_ms");
  });

  it("commits real interruption when interim is not a backchannel (test:real_interrupt_not_suppressed)", async () => {
    const { bus, ttsPlayout, arbiter } = await createArbiter(280);
    const metrics = metricNames(bus);
    const interrupts: InterruptionDetectedPacket[] = [];
    bus.on("interrupt.detected", (pkt) => {
      interrupts.push(pkt as InterruptionDetectedPacket);
    });

    ttsPlayout.noteAudio("assistant-turn", 100, 1000);
    arbiter.noteInterimEvidence("wait stop");
    arbiter.onSpeechStarted(
      {
        kind: "vad.speech_started",
        contextId: "user",
        timestampMs: 2000,
        confidence: 0.99,
      } satisfies VadSpeechStartedPacket,
      "assistant-turn",
    );
    arbiter.onSpeechActivity({
      kind: "vad.speech_activity",
      contextId: "user",
      timestampMs: 2300,
      isAsync: true,
    } satisfies VadSpeechActivityPacket);
    await drainBus();

    expect(interrupts).toHaveLength(1);
    expect(interrupts[0]!.contextId).toBe("assistant-turn");
    expect(metrics).toContain("interrupt.committed_after_ms");
    expect(metrics).not.toContain("interrupt.suppressed_backchannel");
  });

  it("commits sustained speech without interim evidence unchanged", async () => {
    const { bus, ttsPlayout, arbiter } = await createArbiter(280);
    const metrics = metricNames(bus);
    const interrupts: InterruptionDetectedPacket[] = [];
    bus.on("interrupt.detected", (pkt) => {
      interrupts.push(pkt as InterruptionDetectedPacket);
    });

    ttsPlayout.noteAudio("assistant-turn", 100, 1000);
    arbiter.onSpeechStarted(
      {
        kind: "vad.speech_started",
        contextId: "user",
        timestampMs: 2000,
        confidence: 0.99,
      } satisfies VadSpeechStartedPacket,
      "assistant-turn",
    );
    arbiter.onSpeechActivity({
      kind: "vad.speech_activity",
      contextId: "user",
      timestampMs: 2300,
      isAsync: true,
    } satisfies VadSpeechActivityPacket);
    await drainBus();

    expect(interrupts).toHaveLength(1);
    expect(metrics).not.toContain("interrupt.suppressed_backchannel");
  });

  it("locks profile on idle speech end", async () => {
    const gate = new PrimarySpeakerGate();
    const { arbiter } = await createArbiter(280, gate);
    const lockSpy = vi.spyOn(gate, "lockProfileFromFirstTurn");

    const enroll = synthesizeTonePcm16({ frequencyHz: PRIMARY_SPEAKER_TONE_HZ, durationMs: 32 });
    for (let i = 0; i < 8; i += 1) {
      gate.enrollUserTurnChunk(enroll);
    }

    arbiter.onSpeechEnded(
      {
        kind: "vad.speech_ended",
        contextId: "user-first",
        timestampMs: 9000,
      } satisfies VadSpeechEndedPacket,
      false,
    );

    expect(lockSpy).toHaveBeenCalledOnce();
  });
});

describe("TurnArbiter pause-then-resolve barge-in (pauseThenResolveBargeIn)", () => {
  it("emits duck on speech start during active TTS and resume on short-speech suppression", async () => {
    const { bus, ttsPlayout, arbiter } = await createArbiter(280, new PrimarySpeakerGate(), true);
    const ducks: { contextId: string; kind: string }[] = [];
    const resumes: { contextId: string; kind: string }[] = [];
    bus.on("interaction.duck", (pkt) => {
      ducks.push(pkt as unknown as { contextId: string; kind: string });
    });
    bus.on("interaction.resume", (pkt) => {
      resumes.push(pkt as unknown as { contextId: string; kind: string });
    });

    ttsPlayout.noteAudio("assistant-turn", 100, 1000);
    const t0 = 3000;
    arbiter.onSpeechStarted(
      {
        kind: "vad.speech_started",
        contextId: "user",
        timestampMs: t0,
        confidence: 0.99,
      } satisfies VadSpeechStartedPacket,
      "assistant-turn",
    );
    await drainBus();
    expect(ducks).toHaveLength(1);
    expect(ducks[0]!.contextId).toBe("assistant-turn");

    arbiter.onSpeechEnded(
      {
        kind: "vad.speech_ended",
        contextId: "user",
        timestampMs: t0 + 120,
      } satisfies VadSpeechEndedPacket,
      true,
    );
    await drainBus();
    expect(resumes).toHaveLength(1);
    expect(resumes[0]!.contextId).toBe("assistant-turn");
  });

  it("emits duck on speech start and resume on backchannel suppression", async () => {
    const { bus, ttsPlayout, arbiter } = await createArbiter(280, new PrimarySpeakerGate(), true);
    const ducks: { contextId: string; kind: string }[] = [];
    const resumes: { contextId: string; kind: string }[] = [];
    bus.on("interaction.duck", (pkt) => {
      ducks.push(pkt as unknown as { contextId: string; kind: string });
    });
    bus.on("interaction.resume", (pkt) => {
      resumes.push(pkt as unknown as { contextId: string; kind: string });
    });

    ttsPlayout.noteAudio("assistant-turn", 100, 1000);
    arbiter.onSpeechStarted(
      {
        kind: "vad.speech_started",
        contextId: "user",
        timestampMs: 2000,
        confidence: 0.99,
      } satisfies VadSpeechStartedPacket,
      "assistant-turn",
    );
    await drainBus();
    expect(ducks).toHaveLength(1);

    arbiter.noteInterimEvidence("uh huh");
    arbiter.onSpeechActivity({
      kind: "vad.speech_activity",
      contextId: "user",
      timestampMs: 2300,
      isAsync: true,
    } satisfies VadSpeechActivityPacket);
    await drainBus();
    expect(resumes).toHaveLength(1);
    expect(resumes[0]!.contextId).toBe("assistant-turn");
  });

  it("emits NO resume when a real interrupt is committed", async () => {
    const { bus, ttsPlayout, arbiter } = await createArbiter(280, new PrimarySpeakerGate(), true);
    const ducks: { contextId: string; kind: string }[] = [];
    const resumes: { contextId: string; kind: string }[] = [];
    bus.on("interaction.duck", (pkt) => {
      ducks.push(pkt as unknown as { contextId: string; kind: string });
    });
    bus.on("interaction.resume", (pkt) => {
      resumes.push(pkt as unknown as { contextId: string; kind: string });
    });

    ttsPlayout.noteAudio("assistant-turn", 100, 1000);
    arbiter.onSpeechStarted(
      {
        kind: "vad.speech_started",
        contextId: "user",
        timestampMs: 2000,
        confidence: 0.99,
      } satisfies VadSpeechStartedPacket,
      "assistant-turn",
    );
    await drainBus();
    expect(ducks).toHaveLength(1);

    arbiter.onSpeechActivity({
      kind: "vad.speech_activity",
      contextId: "user",
      timestampMs: 2300,
      isAsync: true,
    } satisfies VadSpeechActivityPacket);
    await drainBus();
    expect(resumes).toHaveLength(0);
  });

  it("does NOT emit duck or resume when flag is off", async () => {
    const { bus, ttsPlayout, arbiter } = await createArbiter(280, new PrimarySpeakerGate(), false);
    const ducks: { contextId: string; kind: string }[] = [];
    const resumes: { contextId: string; kind: string }[] = [];
    bus.on("interaction.duck", (pkt) => {
      ducks.push(pkt as unknown as { contextId: string; kind: string });
    });
    bus.on("interaction.resume", (pkt) => {
      resumes.push(pkt as unknown as { contextId: string; kind: string });
    });

    ttsPlayout.noteAudio("assistant-turn", 100, 1000);
    arbiter.onSpeechStarted(
      {
        kind: "vad.speech_started",
        contextId: "user",
        timestampMs: 2000,
        confidence: 0.99,
      } satisfies VadSpeechStartedPacket,
      "assistant-turn",
    );
    arbiter.noteInterimEvidence("uh huh");
    arbiter.onSpeechActivity({
      kind: "vad.speech_activity",
      contextId: "user",
      timestampMs: 2300,
      isAsync: true,
    } satisfies VadSpeechActivityPacket);
    await drainBus();
    expect(ducks).toHaveLength(0);
    expect(resumes).toHaveLength(0);
  });

  it("emits exactly one duck per pending window (no double-duck)", async () => {
    const { bus, ttsPlayout, arbiter } = await createArbiter(280, new PrimarySpeakerGate(), true);
    const ducks: { contextId: string; kind: string }[] = [];
    bus.on("interaction.duck", (pkt) => {
      ducks.push(pkt as unknown as { contextId: string; kind: string });
    });

    ttsPlayout.noteAudio("assistant-turn", 100, 1000);
    arbiter.onSpeechStarted(
      {
        kind: "vad.speech_started",
        contextId: "user",
        timestampMs: 2000,
        confidence: 0.99,
      } satisfies VadSpeechStartedPacket,
      "assistant-turn",
    );
    // Idempotent: second speech start for same user context must not re-duck
    arbiter.onSpeechStarted(
      {
        kind: "vad.speech_started",
        contextId: "user",
        timestampMs: 2100,
        confidence: 0.99,
      } satisfies VadSpeechStartedPacket,
      "assistant-turn",
    );
    await drainBus();
    expect(ducks).toHaveLength(1);
  });
});

describe("isAcknowledgement", () => {
  it("matches exact phrase after normalization", () => {
    expect(isAcknowledgement("Okay", ["okay", "sure"])).toBe(true);
    expect(isAcknowledgement("  OK!  ", ["ok"])).toBe(true);
    expect(isAcknowledgement("uh-huh", ["uh-huh", "uh huh"])).toBe(true);
    expect(isAcknowledgement("uh huh", ["uh-huh", "uh huh"])).toBe(true);
    expect(isAcknowledgement("nope", ["okay", "sure"])).toBe(false);
  });

  it("returns false for empty or whitespace text", () => {
    expect(isAcknowledgement("", ["ok"])).toBe(false);
    expect(isAcknowledgement("   ", ["ok"])).toBe(false);
  });
});

describe("TurnArbiter provider STT evidence", () => {
  it("commits once evidence is sustained past minInterruptionMs", async () => {
    const { bus, ttsPlayout, arbiter } = await createArbiter(280);
    const metrics = metricNames(bus);
    const interrupts: InterruptionDetectedPacket[] = [];
    bus.on("interrupt.detected", (pkt) => {
      interrupts.push(pkt as InterruptionDetectedPacket);
    });

    ttsPlayout.noteAudio("assistant-turn", 100, 1000);
    arbiter.noteInterimEvidence("wait actually");
    arbiter.onProviderSttEvidence("user", 2000, "assistant-turn");
    await drainBus();
    expect(interrupts).toHaveLength(0);

    arbiter.noteInterimEvidence("wait actually I need");
    arbiter.onProviderSttEvidence("user", 2300, "assistant-turn");
    await drainBus();

    expect(interrupts).toHaveLength(1);
    expect(interrupts[0]!.contextId).toBe("assistant-turn");
    expect(metrics).toContain("interrupt.committed_after_ms");
    expect(metrics).toContain("vaqi.interruption");
  });

  it("does not commit while evidence is shorter than minInterruptionMs", async () => {
    const { bus, ttsPlayout, arbiter } = await createArbiter(280);
    const interrupts: InterruptionDetectedPacket[] = [];
    bus.on("interrupt.detected", (pkt) => {
      interrupts.push(pkt as InterruptionDetectedPacket);
    });

    ttsPlayout.noteAudio("assistant-turn", 100, 1000);
    arbiter.onProviderSttEvidence("user", 2000, "assistant-turn");
    arbiter.noteInterimEvidence("hm wait");
    arbiter.onProviderSttEvidence("user", 2100, "assistant-turn");
    await drainBus();

    expect(interrupts).toHaveLength(0);
  });

  it("suppresses backchannel evidence", async () => {
    const { bus, ttsPlayout, arbiter } = await createArbiter(280);
    const metrics = metricNames(bus);
    const interrupts: InterruptionDetectedPacket[] = [];
    bus.on("interrupt.detected", (pkt) => {
      interrupts.push(pkt as InterruptionDetectedPacket);
    });

    ttsPlayout.noteAudio("assistant-turn", 100, 1000);
    arbiter.onProviderSttEvidence("user", 2000, "assistant-turn");
    arbiter.noteInterimEvidence("okay");
    arbiter.onProviderSttEvidence("user", 2300, "assistant-turn");
    await drainBus();

    expect(interrupts).toHaveLength(0);
    expect(metrics).toContain("interrupt.suppressed_backchannel");
  });

  it("ignores evidence for a different user context while a barge-in is pending", async () => {
    const { bus, ttsPlayout, arbiter } = await createArbiter(280);
    const interrupts: InterruptionDetectedPacket[] = [];
    bus.on("interrupt.detected", (pkt) => {
      interrupts.push(pkt as InterruptionDetectedPacket);
    });

    ttsPlayout.noteAudio("assistant-turn", 100, 1000);
    arbiter.onSpeechStarted(
      {
        kind: "vad.speech_started",
        contextId: "user-a",
        timestampMs: 2000,
        confidence: 0.99,
      } satisfies VadSpeechStartedPacket,
      "assistant-turn",
    );
    arbiter.noteInterimEvidence("something from another stream");
    arbiter.onProviderSttEvidence("user-b", 2400, "assistant-turn");
    await drainBus();
    expect(interrupts).toHaveLength(0);

    arbiter.onProviderSttEvidence("user-a", 2400, "assistant-turn");
    await drainBus();
    expect(interrupts).toHaveLength(1);
    expect(interrupts[0]!.contextId).toBe("assistant-turn");
  });
});
