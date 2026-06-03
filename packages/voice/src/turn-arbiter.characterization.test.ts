// SPDX-License-Identifier: MIT
//
// CR-09 Stage 0 — pins the implicit barge-in / turn-taking transition table on the
// session before extraction. Values are observed from driving the real session.

import { describe, it, expect } from "vitest";
import { VoiceAgentSession } from "./voice-agent-session.js";
import { Route } from "./index.js";
import type {
  InterruptTtsPacket,
  TextToSpeechAudioPacket,
  TextToSpeechEndPacket,
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

async function closeSession(session: VoiceAgentSession): Promise<void> {
  if (session.state !== "closed") {
    await session.close();
  }
}

async function enrollPrimarySpeaker(
  session: VoiceAgentSession,
  contextId = "user-enroll",
): Promise<void> {
  const chunk = synthesizeTonePcm16({
    frequencyHz: PRIMARY_SPEAKER_TONE_HZ,
    durationMs: 32,
  });
  const t0 = Date.now();
  session.bus.push(Route.Main, {
    kind: "vad.speech_started",
    contextId,
    timestampMs: t0,
    confidence: 0.99,
  } satisfies VadSpeechStartedPacket);
  for (let i = 0; i < 12; i += 1) {
    session.bus.push(Route.Main, {
      kind: "user.audio_received",
      contextId,
      timestampMs: t0 + i * 20,
      audio: chunk,
    });
  }
  session.bus.push(Route.Main, {
    kind: "vad.speech_ended",
    contextId,
    timestampMs: t0 + 300,
  } satisfies VadSpeechEndedPacket);
  await new Promise((resolve) => setTimeout(resolve, 10));
}

function armAssistantSpeaking(session: VoiceAgentSession, contextId = "assistant-turn"): void {
  session.bus.push(Route.Main, {
    kind: "tts.audio",
    contextId,
    timestampMs: Date.now(),
    audio: new Uint8Array([1, 2, 3, 4]),
    sampleRateHz: 16000,
  } satisfies TextToSpeechAudioPacket);
}

function collectMetrics(session: VoiceAgentSession): {
  names: string[];
  pairs: Array<{ name: string; value: string }>;
} {
  const names: string[] = [];
  const pairs: Array<{ name: string; value: string }> = [];
  session.bus.on("metric.conversation", (pkt) => {
    const m = pkt as unknown as { name: string; value: string };
    names.push(m.name);
    pairs.push({ name: m.name, value: m.value });
  });
  return { names, pairs };
}

describe("turn-taking transition table (CR-09 characterization)", () => {
  it("suppresses short speech blip via interrupt.suppressed_short_speech", async () => {
    const session = new VoiceAgentSession({ plugins: {}, minInterruptionMs: 280 });
    const interrupts: InterruptTtsPacket[] = [];
    const { names: metrics } = collectMetrics(session);

    await session.start();
    session.bus.on("interrupt.tts", (pkt) => {
      interrupts.push(pkt as InterruptTtsPacket);
    });
    armAssistantSpeaking(session);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const t0 = 1000;
    session.bus.push(Route.Main, {
      kind: "vad.speech_started",
      contextId: "user",
      timestampMs: t0,
      confidence: 0.99,
    } satisfies VadSpeechStartedPacket);
    session.bus.push(Route.Main, {
      kind: "vad.speech_activity",
      contextId: "user",
      timestampMs: t0 + 90,
      isAsync: true,
    } satisfies VadSpeechActivityPacket);
    session.bus.push(Route.Main, {
      kind: "vad.speech_ended",
      contextId: "user",
      timestampMs: t0 + 130,
    } satisfies VadSpeechEndedPacket);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(interrupts).toEqual([]);
    expect(metrics).toContain("interrupt.suppressed_short_speech");

    await closeSession(session);
  });

  it("commits sustained speech via interrupt.committed_after_ms and interrupt.detected", async () => {
    const session = new VoiceAgentSession({ plugins: {}, minInterruptionMs: 280 });
    const interrupts: InterruptTtsPacket[] = [];
    const { names: metrics, pairs } = collectMetrics(session);

    await session.start();
    session.bus.on("interrupt.tts", (pkt) => {
      interrupts.push(pkt as InterruptTtsPacket);
    });
    armAssistantSpeaking(session);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const t0 = 2000;
    session.bus.push(Route.Main, {
      kind: "vad.speech_started",
      contextId: "user",
      timestampMs: t0,
      confidence: 0.99,
    } satisfies VadSpeechStartedPacket);
    session.bus.push(Route.Main, {
      kind: "vad.speech_activity",
      contextId: "user",
      timestampMs: t0 + 300,
      isAsync: true,
    } satisfies VadSpeechActivityPacket);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(interrupts).toEqual([
      expect.objectContaining({ kind: "interrupt.tts", contextId: "assistant-turn" }),
    ]);
    expect(metrics).toContain("interrupt.committed_after_ms");
    expect(metrics).toContain("vaqi.interruption");
    expect(metrics).toContain("interrupt.latency_ms");
    expect(pairs).toContainEqual({ name: "interrupt.latency_ms", value: "300" });

    await closeSession(session);
  });

  it("suppresses non-primary speaker via interrupt.suppressed_non_primary", async () => {
    const session = new VoiceAgentSession({ plugins: {}, minInterruptionMs: 280 });
    const interrupts: InterruptTtsPacket[] = [];
    const { names: metrics } = collectMetrics(session);

    await session.start();
    session.bus.on("interrupt.tts", (pkt) => {
      interrupts.push(pkt as InterruptTtsPacket);
    });
    await enrollPrimarySpeaker(session);
    armAssistantSpeaking(session);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const bystander = synthesizeTonePcm16({
      frequencyHz: BYSTANDER_SPEAKER_TONE_HZ,
      durationMs: 32,
    });
    const t0 = 3000;
    session.bus.push(Route.Main, {
      kind: "vad.speech_started",
      contextId: "user-barge",
      timestampMs: t0,
      confidence: 0.99,
    } satisfies VadSpeechStartedPacket);
    for (let i = 0; i < 10; i += 1) {
      session.bus.push(Route.Main, {
        kind: "vad.audio",
        contextId: "user-barge",
        timestampMs: t0 + 20 + i * 30,
        audio: bystander,
      } satisfies VadAudioPacket);
    }
    session.bus.push(Route.Main, {
      kind: "vad.speech_activity",
      contextId: "user-barge",
      timestampMs: t0 + 320,
      isAsync: true,
    } satisfies VadSpeechActivityPacket);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(interrupts).toEqual([]);
    expect(metrics).toContain("interrupt.suppressed_non_primary");

    await closeSession(session);
  });

  it("cuts immediately when minInterruptionMs is 0 and no speaker profile", async () => {
    const session = new VoiceAgentSession({ plugins: {}, minInterruptionMs: 0 });
    const interrupts: InterruptTtsPacket[] = [];
    const { pairs } = collectMetrics(session);

    await session.start();
    session.bus.on("interrupt.tts", (pkt) => {
      interrupts.push(pkt as InterruptTtsPacket);
    });
    armAssistantSpeaking(session);
    await new Promise((resolve) => setTimeout(resolve, 10));

    session.bus.push(Route.Main, {
      kind: "vad.speech_started",
      contextId: "user",
      timestampMs: 4000,
      confidence: 0.99,
    } satisfies VadSpeechStartedPacket);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(interrupts).toEqual([
      expect.objectContaining({ kind: "interrupt.tts", contextId: "assistant-turn" }),
    ]);
    expect(pairs).toEqual([
      { name: "vaqi.interruption", value: "1" },
      { name: "interrupt.onset_to_logic_cancel_ms", value: "0" },
    ]);

    await closeSession(session);
  });

  it("resolves without cut when playout ended via interrupt.gate_resolved_after_tts_end", async () => {
    const session = new VoiceAgentSession({ plugins: {}, minInterruptionMs: 280 });
    const interrupts: InterruptTtsPacket[] = [];
    const { names: metrics } = collectMetrics(session);

    await session.start();
    session.bus.on("interrupt.tts", (pkt) => {
      interrupts.push(pkt as InterruptTtsPacket);
    });
    armAssistantSpeaking(session);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const t0 = 5000;
    session.bus.push(Route.Main, {
      kind: "vad.speech_started",
      contextId: "user",
      timestampMs: t0,
      confidence: 0.99,
    } satisfies VadSpeechStartedPacket);
    session.bus.push(Route.Main, {
      kind: "tts.end",
      contextId: "assistant-turn",
      timestampMs: t0 + 50,
    } satisfies TextToSpeechEndPacket);
    await new Promise((resolve) => setTimeout(resolve, 10));
    session.bus.push(Route.Main, {
      kind: "vad.speech_activity",
      contextId: "user",
      timestampMs: t0 + 300,
      isAsync: true,
    } satisfies VadSpeechActivityPacket);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(interrupts).toEqual([]);
    expect(metrics).toContain("interrupt.gate_resolved_after_tts_end");

    await closeSession(session);
  });

  it("defers immediate cut until vad.audio when speaker profile is enrolled", async () => {
    const session = new VoiceAgentSession({ plugins: {}, minInterruptionMs: 0 });
    const interrupts: InterruptTtsPacket[] = [];
    const { names: metrics } = collectMetrics(session);

    await session.start();
    session.bus.on("interrupt.tts", (pkt) => {
      interrupts.push(pkt as InterruptTtsPacket);
    });
    await enrollPrimarySpeaker(session);
    armAssistantSpeaking(session);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const primary = synthesizeTonePcm16({
      frequencyHz: PRIMARY_SPEAKER_TONE_HZ,
      durationMs: 32,
    });
    const t0 = 6000;
    session.bus.push(Route.Main, {
      kind: "vad.speech_started",
      contextId: "user-barge",
      timestampMs: t0,
      confidence: 0.99,
    } satisfies VadSpeechStartedPacket);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(interrupts).toEqual([]);
    expect(metrics).not.toContain("vaqi.interruption");

    session.bus.push(Route.Main, {
      kind: "vad.audio",
      contextId: "user-barge",
      timestampMs: t0 + 5,
      audio: primary,
    } satisfies VadAudioPacket);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(interrupts).toEqual([
      expect.objectContaining({ kind: "interrupt.tts", contextId: "assistant-turn" }),
    ]);
    expect(metrics).toContain("vaqi.interruption");

    await closeSession(session);
  });

  it("locks primary speaker profile on idle speech end", async () => {
    const session = new VoiceAgentSession({ plugins: {}, minInterruptionMs: 280 });
    const interrupts: InterruptTtsPacket[] = [];
    const { names: metrics } = collectMetrics(session);

    await session.start();
    session.bus.on("interrupt.tts", (pkt) => {
      interrupts.push(pkt as InterruptTtsPacket);
    });

    const enrollChunk = synthesizeTonePcm16({
      frequencyHz: PRIMARY_SPEAKER_TONE_HZ,
      durationMs: 32,
    });
    const t0 = 7000;
    session.bus.push(Route.Main, {
      kind: "vad.speech_started",
      contextId: "user-first",
      timestampMs: t0,
      confidence: 0.99,
    } satisfies VadSpeechStartedPacket);
    for (let i = 0; i < 8; i += 1) {
      session.bus.push(Route.Main, {
        kind: "user.audio_received",
        contextId: "user-first",
        timestampMs: t0 + i * 20,
        audio: enrollChunk,
      });
    }
    session.bus.push(Route.Main, {
      kind: "vad.speech_ended",
      contextId: "user-first",
      timestampMs: t0 + 200,
    } satisfies VadSpeechEndedPacket);
    await new Promise((resolve) => setTimeout(resolve, 10));

    armAssistantSpeaking(session);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const bystander = synthesizeTonePcm16({
      frequencyHz: BYSTANDER_SPEAKER_TONE_HZ,
      durationMs: 32,
    });
    const t1 = 8000;
    session.bus.push(Route.Main, {
      kind: "vad.speech_started",
      contextId: "user-barge",
      timestampMs: t1,
      confidence: 0.99,
    } satisfies VadSpeechStartedPacket);
    for (let i = 0; i < 10; i += 1) {
      session.bus.push(Route.Main, {
        kind: "vad.audio",
        contextId: "user-barge",
        timestampMs: t1 + 20 + i * 30,
        audio: bystander,
      } satisfies VadAudioPacket);
    }
    session.bus.push(Route.Main, {
      kind: "vad.speech_activity",
      contextId: "user-barge",
      timestampMs: t1 + 320,
      isAsync: true,
    } satisfies VadSpeechActivityPacket);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(interrupts).toEqual([]);
    expect(metrics).toContain("interrupt.suppressed_non_primary");

    await closeSession(session);
  });

  it("ignores uplink audio before vad.speech_started when enrolling the primary speaker", async () => {
    const session = new VoiceAgentSession({ plugins: {}, minInterruptionMs: 280 });
    const interrupts: InterruptTtsPacket[] = [];
    const { names: metrics } = collectMetrics(session);

    await session.start();
    session.bus.on("interrupt.tts", (pkt) => {
      interrupts.push(pkt as InterruptTtsPacket);
    });

    const bystander = synthesizeTonePcm16({
      frequencyHz: BYSTANDER_SPEAKER_TONE_HZ,
      durationMs: 32,
    });
    const primary = synthesizeTonePcm16({
      frequencyHz: PRIMARY_SPEAKER_TONE_HZ,
      durationMs: 32,
    });
    for (let i = 0; i < 20; i += 1) {
      session.bus.push(Route.Main, {
        kind: "user.audio_received",
        contextId: "user-enroll",
        timestampMs: 500 + i * 10,
        audio: bystander,
      });
    }

    const t0 = 1000;
    session.bus.push(Route.Main, {
      kind: "vad.speech_started",
      contextId: "user-enroll",
      timestampMs: t0,
      confidence: 0.99,
    } satisfies VadSpeechStartedPacket);
    for (let i = 0; i < 12; i += 1) {
      session.bus.push(Route.Main, {
        kind: "user.audio_received",
        contextId: "user-enroll",
        timestampMs: t0 + 20 + i * 20,
        audio: primary,
      });
    }
    session.bus.push(Route.Main, {
      kind: "vad.speech_ended",
      contextId: "user-enroll",
      timestampMs: t0 + 300,
    } satisfies VadSpeechEndedPacket);
    await new Promise((resolve) => setTimeout(resolve, 10));

    armAssistantSpeaking(session);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const t1 = 2000;
    session.bus.push(Route.Main, {
      kind: "vad.speech_started",
      contextId: "user-barge",
      timestampMs: t1,
      confidence: 0.99,
    } satisfies VadSpeechStartedPacket);
    for (let i = 0; i < 8; i += 1) {
      session.bus.push(Route.Main, {
        kind: "vad.audio",
        contextId: "user-barge",
        timestampMs: t1 + 20 + i * 30,
        audio: primary,
      } satisfies VadAudioPacket);
    }
    session.bus.push(Route.Main, {
      kind: "vad.speech_activity",
      contextId: "user-barge",
      timestampMs: t1 + 320,
      isAsync: true,
    } satisfies VadSpeechActivityPacket);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(interrupts).toEqual([
      expect.objectContaining({ kind: "interrupt.tts", contextId: "assistant-turn" }),
    ]);
    expect(metrics).not.toContain("interrupt.suppressed_non_primary");

    await closeSession(session);
  });
});
