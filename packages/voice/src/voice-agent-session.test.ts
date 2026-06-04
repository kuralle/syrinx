// SPDX-License-Identifier: MIT

import { describe, it, expect, vi } from "vitest";
import { VoiceAgentSession } from "./voice-agent-session.js";
import { Route, type PipelineBus, type PluginConfig, type VoicePlugin } from "./index.js";
import { ErrorCategory } from "./packets.js";
import type {
  EndOfSpeechAudioPacket,
  RecordAssistantAudioPacket,
  RecordUserAudioPacket,
  SpeechToTextAudioPacket,
  SttResultPacket,
  EndOfSpeechPacket,
  LlmDeltaPacket,
  LlmResponseDonePacket,
  TextToSpeechDonePacket,
  TextToSpeechAudioPacket,
  TextToSpeechEndPacket,
  TextToSpeechPlayoutProgressPacket,
  TextToSpeechTextPacket,
  InterruptTtsPacket,
  InterruptLlmPacket,
  InterruptionDetectedPacket,
  VadSpeechEndedPacket,
  UserAudioReceivedPacket,
  UserInputPacket,
  VadAudioPacket,
  ModeSwitchCompletedPacket,
  VadSpeechStartedPacket,
  VadSpeechActivityPacket,
  LlmErrorPacket,
  TtsErrorPacket,
  PipelineErrorPacket,
} from "./packets.js";
import {
  BYSTANDER_SPEAKER_TONE_HZ,
  PRIMARY_SPEAKER_TONE_HZ,
  ASSISTANT_ECHO_TONE_HZ,
  synthesizeTonePcm16,
} from "./primary-speaker-fixtures.js";

class CapturingPlugin implements VoicePlugin {
  config: PluginConfig | null = null;
  forceFinalize = vi.fn();

  async initialize(_bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.config = config;
  }

  async close(): Promise<void> {
    // no-op
  }
}

class OrderedClosePlugin implements VoicePlugin {
  constructor(
    private readonly name: string,
    private readonly closeOrder: string[],
  ) {}

  async initialize(): Promise<void> {
    // no-op
  }

  async close(): Promise<void> {
    this.closeOrder.push(this.name);
  }
}

class SlowClosePlugin implements VoicePlugin {
  closeCount = 0;

  async initialize(): Promise<void> {
    // no-op
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

class FailingInitPlugin implements VoicePlugin {
  async initialize(): Promise<void> {
    throw new Error("init failed");
  }

  async close(): Promise<void> {
    // no-op
  }
}

class EndpointingPlugin extends CapturingPlugin {
  initializeCount = 0;

  constructor(readonly endpointingCapability: NonNullable<VoicePlugin["endpointingCapability"]>) {
    super();
  }

  override async initialize(bus: PipelineBus, config: PluginConfig): Promise<void> {
    this.initializeCount += 1;
    await super.initialize(bus, config);
  }
}

class InterruptAwareStreamingTtsPlugin implements VoicePlugin {
  private bus: PipelineBus | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private contextId = "";
  emittedAudioCount = 0;
  interruptObservedAtMs = 0;

  async initialize(bus: PipelineBus): Promise<void> {
    this.bus = bus;
    bus.on("tts.text", (pkt) => {
      this.startStreaming((pkt as TextToSpeechTextPacket).contextId);
    });
    bus.on("interrupt.tts", (pkt) => {
      this.interruptObservedAtMs = performance.now();
      this.stopStreaming();
      this.bus?.push(Route.Main, {
        kind: "tts.end",
        contextId: (pkt as InterruptTtsPacket).contextId,
        timestampMs: Date.now(),
      });
    });
  }

  async close(): Promise<void> {
    this.stopStreaming();
    this.bus = null;
  }

  private startStreaming(contextId: string): void {
    this.contextId = contextId;
    if (this.interval) return;
    this.interval = setInterval(() => {
      this.emittedAudioCount++;
      this.bus?.push(Route.Main, {
        kind: "tts.audio",
        contextId: this.contextId,
        timestampMs: Date.now(),
        audio: new Uint8Array([1, 2, 3, 4]),
        sampleRateHz: 16000,
      } satisfies TextToSpeechAudioPacket);
    }, 5);
  }

  private stopStreaming(): void {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
  }
}

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
    } satisfies UserAudioReceivedPacket);
  }
  session.bus.push(Route.Main, {
    kind: "vad.speech_ended",
    contextId,
    timestampMs: t0 + 300,
  } satisfies VadSpeechEndedPacket);
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("VoiceAgentSession", () => {
  it("passes configured plugin options to each plugin during initialization", async () => {
    const plugin = new CapturingPlugin();
    const session = new VoiceAgentSession({
      plugins: {
        stt: {
          api_key: "test-key",
          endpointing: 300,
        },
      },
    });

    session.registerPlugin("stt", plugin);
    await session.start();

    expect(plugin.config).toEqual({
      api_key: "test-key",
      endpointing: 300,
    });

    await closeSession(session);
  });

  it("force-finalizes STT when audio stops and no final result arrives", async () => {
    const plugin = new CapturingPlugin();
    const session = new VoiceAgentSession({
      plugins: { stt: {} },
      sttForceFinalizeTimeoutMs: 10,
    });

    session.registerPlugin("stt", plugin);
    await session.start();

    const audioPacket: SpeechToTextAudioPacket = {
      kind: "stt.audio",
      contextId: "turn-1",
      timestampMs: Date.now(),
      audio: new Uint8Array([1, 2, 3, 4]),
    };
    session.bus.push(Route.Main, audioPacket);

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(plugin.forceFinalize).toHaveBeenCalledTimes(1);
    expect(plugin.forceFinalize).toHaveBeenCalledWith("turn-1");

    await closeSession(session);
  });

  it("cancels pending STT force-finalization when a final result arrives", async () => {
    const plugin = new CapturingPlugin();
    const session = new VoiceAgentSession({
      plugins: { stt: {} },
      sttForceFinalizeTimeoutMs: 30,
    });

    session.registerPlugin("stt", plugin);
    await session.start();

    const audioPacket: SpeechToTextAudioPacket = {
      kind: "stt.audio",
      contextId: "turn-1",
      timestampMs: Date.now(),
      audio: new Uint8Array([1, 2, 3, 4]),
    };
    session.bus.push(Route.Main, audioPacket);

    await new Promise((resolve) => setTimeout(resolve, 5));

    const finalPacket: SttResultPacket = {
      kind: "stt.result",
      contextId: "turn-1",
      timestampMs: Date.now(),
      text: "hello",
      confidence: 0.99,
    };
    session.bus.push(Route.Main, finalPacket);

    await new Promise((resolve) => setTimeout(resolve, 45));

    expect(plugin.forceFinalize).not.toHaveBeenCalled();

    await closeSession(session);
  });

  it("fans user audio out to recorder, VAD, STT, and EOS routes", async () => {
    const session = new VoiceAgentSession({ plugins: {}, endpointingOwner: "smart_turn" });
    await session.start();

    const recordPackets: RecordUserAudioPacket[] = [];
    const vadPackets: VadAudioPacket[] = [];
    const sttPackets: SpeechToTextAudioPacket[] = [];
    const eosPackets: EndOfSpeechAudioPacket[] = [];

    session.bus.on("record.user_audio", (pkt) => {
      recordPackets.push(pkt as RecordUserAudioPacket);
    });
    session.bus.on("vad.audio", (pkt) => {
      vadPackets.push(pkt as VadAudioPacket);
    });
    session.bus.on("stt.audio", (pkt) => {
      sttPackets.push(pkt as SpeechToTextAudioPacket);
    });
    session.bus.on("eos.audio", (pkt) => {
      eosPackets.push(pkt as EndOfSpeechAudioPacket);
    });

    const audio = new Uint8Array([1, 2, 3, 4]);
    const userAudioPacket: UserAudioReceivedPacket = {
      kind: "user.audio_received",
      contextId: "turn-1",
      timestampMs: Date.now(),
      audio,
    };
    session.bus.push(Route.Main, userAudioPacket);

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(recordPackets).toHaveLength(1);
    expect(vadPackets).toHaveLength(1);
    expect(sttPackets).toHaveLength(1);
    expect(eosPackets).toHaveLength(1);
    expect(recordPackets[0]!.audio).toBe(audio);
    expect(vadPackets[0]!.audio).toBe(audio);
    expect(sttPackets[0]!.audio).toBe(audio);
    expect(eosPackets[0]!.audio).toBe(audio);

    await closeSession(session);
  });

  it("emits normalized debug events for bus packets", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const reader = session.debugEvents.getReader();
    await session.start();

    session.bus.push(Route.Main, {
      kind: "user.text_received",
      contextId: "turn-1",
      timestampMs: Date.now(),
      text: "hello",
    });

    let first = await reader.read();
    while (!first.done && first.value?.data.kind !== "user.text_received") {
      first = await reader.read();
    }
    reader.releaseLock();

    expect(first.value).toMatchObject({
      component: "bus",
      type: "packet",
      data: {
        context_id: "turn-1",
        route: "Main",
        kind: "user.text_received",
      },
    });

    await closeSession(session);
  });

  it("finalizes plugins in deterministic reverse stage order", async () => {
    const closeOrder: string[] = [];
    const session = new VoiceAgentSession({
      plugins: {
        recorder: {},
        tts: {},
        vad: {},
        stt: {},
      },
    });

    session.registerPlugin("recorder", new OrderedClosePlugin("recorder", closeOrder));
    session.registerPlugin("tts", new OrderedClosePlugin("tts", closeOrder));
    session.registerPlugin("vad", new OrderedClosePlugin("vad", closeOrder));
    session.registerPlugin("stt", new OrderedClosePlugin("stt", closeOrder));

    await session.start();
    await session.close();

    expect(closeOrder).toEqual(["vad", "tts", "stt", "recorder"]);
  });

  it("shares one in-flight close across concurrent callers", async () => {
    const plugin = new SlowClosePlugin();
    const session = new VoiceAgentSession({ plugins: { recorder: {} } });

    session.registerPlugin("recorder", plugin);
    await session.start();
    await Promise.all([session.close(), session.close(), session.close()]);

    expect(plugin.closeCount).toBe(1);
    expect(session.state).toBe("closed");
  });

  it("tears down initialized plugins in reverse order after init failure", async () => {
    const closeOrder: string[] = [];
    const errors: Array<{ stage: string; message: string }> = [];
    const session = new VoiceAgentSession({
      plugins: {
        recorder: {},
        stt: {},
        tts: {},
      },
    });

    session.registerPlugin("recorder", new OrderedClosePlugin("recorder", closeOrder));
    session.registerPlugin("stt", new OrderedClosePlugin("stt", closeOrder));
    session.registerPlugin("tts", new FailingInitPlugin());
    session.on("error", (event) => {
      errors.push({ stage: event.stage, message: event.message });
    });

    await expect(session.start()).rejects.toThrow("Initialization failed at tts/tts");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(session.state).toBe("failed");
    expect(closeOrder).toEqual(["stt", "recorder"]);
    expect(errors).toEqual([
      expect.objectContaining({
        stage: "init.tts",
        message: expect.stringContaining("Initialization failed: tts/tts"),
      }),
    ]);

    await closeSession(session);
  });

  it("switches audio to text immediately and tears down audio plugins in background", async () => {
    const closeOrder: string[] = [];
    const session = new VoiceAgentSession({
      plugins: {
        stt: {},
        tts: {},
        vad: {},
      },
    });
    const completed: ModeSwitchCompletedPacket[] = [];

    session.registerPlugin("stt", new OrderedClosePlugin("stt", closeOrder));
    session.registerPlugin("tts", new OrderedClosePlugin("tts", closeOrder));
    session.registerPlugin("vad", new OrderedClosePlugin("vad", closeOrder));

    await session.start();
    session.bus.on("mode.switch_completed", (pkt) => {
      completed.push(pkt as ModeSwitchCompletedPacket);
    });

    await session.switchMode("text");
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(completed).toEqual([
      expect.objectContaining({
        kind: "mode.switch_completed",
        mode: "text",
      }),
    ]);
    expect(closeOrder).toEqual(["vad", "tts", "stt"]);

    await closeSession(session);
  });

  it("routes EOS completions to normalized user input", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const userInputs: UserInputPacket[] = [];

    await session.start();
    session.bus.on("user.input", (pkt) => {
      userInputs.push(pkt as UserInputPacket);
    });

    const eosPacket: EndOfSpeechPacket = {
      kind: "eos.turn_complete",
      contextId: "turn-1",
      timestampMs: Date.now(),
      text: "hello world",
      transcripts: [
        {
          kind: "stt.result",
          contextId: "turn-1",
          timestampMs: Date.now(),
          text: "hello world",
          confidence: 0.9,
          language: "en-US",
        },
      ],
    };
    session.bus.push(Route.Main, eosPacket);

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(userInputs).toEqual([
      {
        kind: "user.input",
        contextId: "turn-1",
        timestampMs: expect.any(Number),
        text: "hello world",
        language: "en-US",
      },
    ]);

    await closeSession(session);
  });

  it("routes sentence-complete LLM output to TTS text and done packets", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const ttsText: TextToSpeechTextPacket[] = [];
    const ttsDone: TextToSpeechDonePacket[] = [];

    await session.start();
    session.bus.on("tts.text", (pkt) => {
      ttsText.push(pkt as TextToSpeechTextPacket);
    });
    session.bus.on("tts.done", (pkt) => {
      ttsDone.push(pkt as TextToSpeechDonePacket);
    });

    const deltaPacket: LlmDeltaPacket = {
      kind: "llm.delta",
      contextId: "turn-1",
      timestampMs: Date.now(),
      text: "Hello ",
    };
    const deltaPacket2: LlmDeltaPacket = {
      kind: "llm.delta",
      contextId: "turn-1",
      timestampMs: Date.now(),
      text: "there. How can I help",
    };
    const donePacket: LlmResponseDonePacket = {
      kind: "llm.done",
      contextId: "turn-1",
      timestampMs: Date.now(),
      text: "Hello there. How can I help",
    };
    session.bus.push(Route.Main, deltaPacket);
    session.bus.push(Route.Main, deltaPacket2);
    session.bus.push(Route.Main, donePacket);

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(ttsText).toEqual([
      {
        kind: "tts.text",
        contextId: "turn-1",
        timestampMs: expect.any(Number),
        text: "Hello there.",
      },
      {
        kind: "tts.text",
        contextId: "turn-1",
        timestampMs: expect.any(Number),
        text: "How can I help",
      },
    ]);
    expect(ttsDone).toEqual([
      {
        kind: "tts.done",
        contextId: "turn-1",
        timestampMs: expect.any(Number),
        text: "Hello there. How can I help",
      },
    ]);

    await closeSession(session);
  });

  it("flushes final LLM tails to TTS when the provider completes", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const ttsText: TextToSpeechTextPacket[] = [];
    const ttsDone: TextToSpeechDonePacket[] = [];
    const flushed: string[] = [];

    await session.start();
    session.bus.on("tts.text", (pkt) => {
      ttsText.push(pkt as TextToSpeechTextPacket);
    });
    session.bus.on("tts.done", (pkt) => {
      ttsDone.push(pkt as TextToSpeechDonePacket);
    });
    session.bus.on("metric.conversation", (pkt) => {
      const metric = pkt as unknown as { name: string; value: string };
      if (metric.name === "tts.final_tail_flushed") flushed.push(metric.value);
    });

    session.bus.push(Route.Main, {
      kind: "llm.delta",
      contextId: "turn-1",
      timestampMs: Date.now(),
      text: "You should contact your instructor and upload their email",
    } satisfies LlmDeltaPacket);
    session.bus.push(Route.Main, {
      kind: "llm.done",
      contextId: "turn-1",
      timestampMs: Date.now(),
      text: "You should contact your instructor and upload their email",
    } satisfies LlmResponseDonePacket);

    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(ttsText).toEqual([
      {
        kind: "tts.text",
        contextId: "turn-1",
        timestampMs: expect.any(Number),
        text: "You should contact your instructor and upload their email",
      },
    ]);
    expect(ttsDone).toEqual([
      {
        kind: "tts.done",
        contextId: "turn-1",
        timestampMs: expect.any(Number),
        text: "You should contact your instructor and upload their email",
      },
    ]);
    expect(flushed).toEqual(["You should contact your instructor and upload their email"]);

    await closeSession(session);
  });

  it("streams non-English terminal punctuation as complete TTS text", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const ttsText: TextToSpeechTextPacket[] = [];

    await session.start();
    session.bus.on("tts.text", (pkt) => {
      ttsText.push(pkt as TextToSpeechTextPacket);
    });

    session.bus.push(Route.Main, {
      kind: "llm.delta",
      contextId: "turn-1",
      timestampMs: Date.now(),
      text: "手続きできます。次の文はまだ",
    } satisfies LlmDeltaPacket);
    session.bus.push(Route.Main, {
      kind: "llm.done",
      contextId: "turn-1",
      timestampMs: Date.now(),
      text: "手続きできます。次の文はまだ",
    } satisfies LlmResponseDonePacket);

    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(ttsText).toEqual([
      {
        kind: "tts.text",
        contextId: "turn-1",
        timestampMs: expect.any(Number),
        text: "手続きできます。",
      },
      {
        kind: "tts.text",
        contextId: "turn-1",
        timestampMs: expect.any(Number),
        text: "次の文はまだ",
      },
    ]);

    await closeSession(session);
  });

  it("routes TTS audio to assistant recording", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const recorded: RecordAssistantAudioPacket[] = [];

    await session.start();
    session.bus.on("record.assistant_audio", (pkt) => {
      recorded.push(pkt as RecordAssistantAudioPacket);
    });

    const audio = new Uint8Array([1, 2, 3, 4]);
    const ttsAudioPacket: TextToSpeechAudioPacket = {
      kind: "tts.audio",
      contextId: "turn-1",
      timestampMs: Date.now(),
      audio,
      sampleRateHz: 16000,
    };
    session.bus.push(Route.Main, ttsAudioPacket);

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(recorded).toEqual([
      {
        kind: "record.assistant_audio",
        contextId: "turn-1",
        timestampMs: expect.any(Number),
        audio,
        sampleRateHz: 16000,
        truncate: false,
      },
    ]);

    await closeSession(session);
  });

  it("rejects TTS audio without sample-rate metadata before recording it", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const recorded: RecordAssistantAudioPacket[] = [];
    const errors: Array<{ stage: string; message: string }> = [];

    await session.start();
    session.bus.on("record.assistant_audio", (pkt) => {
      recorded.push(pkt as RecordAssistantAudioPacket);
    });
    session.on("error", (event) => {
      errors.push({ stage: event.stage, message: event.message });
    });

    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "turn-missing-rate",
      timestampMs: Date.now(),
      audio: new Uint8Array([1, 2, 3, 4]),
    } as unknown as TextToSpeechAudioPacket);

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(recorded).toEqual([]);
    expect(errors).toEqual([
      expect.objectContaining({
        stage: "pipeline.error",
        message: "tts.audio sampleRateHz must be a positive integer",
      }),
    ]);

    await closeSession(session);
  });

  it("uses TTS audio sample-rate metadata for idle playback timing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const session = new VoiceAgentSession({
      plugins: {},
      idleTimeout: {
        durationMs: 100,
        maxConsecutive: 0,
        escalationMessages: ["still there?"],
        disconnectAfterMax: false,
      },
    });
    const injected: string[] = [];

    await session.start();
    session.bus.on("inject.message", (pkt) => {
      injected.push((pkt as unknown as { text: string }).text);
    });

    try {
      session.bus.push(Route.Main, {
        kind: "behavior.idle_timeout_start",
        contextId: "turn-1",
        timestampMs: Date.now(),
      });
      await vi.advanceTimersByTimeAsync(0);

      session.bus.push(Route.Main, {
        kind: "tts.audio",
        contextId: "turn-1",
        timestampMs: Date.now(),
        audio: new Uint8Array(3200),
        sampleRateHz: 16000,
      } satisfies TextToSpeechAudioPacket);
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(199);
      expect(injected).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(injected).toEqual(["still there?"]);
    } finally {
      vi.useRealTimers();
      await closeSession(session);
    }
  });

  it("stops assistant audio output within 50ms of VAD barge-in", async () => {
    const tts = new InterruptAwareStreamingTtsPlugin();
    // Gate disabled: this test exercises the immediate-cut path latency.
    const session = new VoiceAgentSession({ plugins: { tts: {} }, minInterruptionMs: 0 });
    const recordedAtMs: number[] = [];
    const interrupts: InterruptTtsPacket[] = [];

    session.registerPlugin("tts", tts);
    await session.start();
    session.bus.on("record.assistant_audio", () => {
      recordedAtMs.push(performance.now());
    });
    session.bus.on("interrupt.tts", (pkt) => {
      interrupts.push(pkt as InterruptTtsPacket);
    });

    session.bus.push(Route.Main, {
      kind: "tts.text",
      contextId: "assistant-turn",
      timestampMs: Date.now(),
      text: "stream until interrupted",
    } satisfies TextToSpeechTextPacket);

    while (recordedAtMs.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    const vadDetectedAtMs = performance.now();
    session.bus.push(Route.Main, {
      kind: "vad.speech_started",
      contextId: "user-barge-in",
      timestampMs: Date.now(),
      confidence: 0.99,
    } satisfies VadSpeechStartedPacket);

    await new Promise((resolve) => setTimeout(resolve, 80));

    const lastAudioAfterVadMs = Math.max(
      0,
      ...recordedAtMs.filter((timestampMs) => timestampMs >= vadDetectedAtMs)
        .map((timestampMs) => timestampMs - vadDetectedAtMs),
    );

    expect(interrupts).toEqual([
      expect.objectContaining({
        kind: "interrupt.tts",
        contextId: "assistant-turn",
      }),
    ]);
    expect(tts.interruptObservedAtMs - vadDetectedAtMs).toBeLessThan(50);
    expect(lastAudioAfterVadMs).toBeLessThan(50);

    await closeSession(session);
  });

  it("commits a barge-in only after user speech is sustained past minInterruptionMs", async () => {
    const session = new VoiceAgentSession({ plugins: {}, minInterruptionMs: 280 });
    const interrupts: InterruptTtsPacket[] = [];
    const metrics: string[] = [];

    await session.start();
    session.bus.on("interrupt.tts", (pkt) => {
      interrupts.push(pkt as InterruptTtsPacket);
    });
    session.bus.on("metric.conversation", (pkt) => {
      metrics.push((pkt as unknown as { name: string }).name);
    });

    // Assistant is speaking.
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "assistant-turn",
      timestampMs: Date.now(),
      audio: new Uint8Array([1, 2, 3, 4]),
      sampleRateHz: 16000,
    } satisfies TextToSpeechAudioPacket);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const t0 = Date.now();
    session.bus.push(Route.Main, {
      kind: "vad.speech_started",
      contextId: "user",
      timestampMs: t0,
      confidence: 0.99,
    } satisfies VadSpeechStartedPacket);
    // Activity below threshold — no interrupt yet.
    session.bus.push(Route.Main, {
      kind: "vad.speech_activity",
      contextId: "user",
      timestampMs: t0 + 100,
      isAsync: true,
    } satisfies VadSpeechActivityPacket);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(interrupts).toEqual([]);

    // Activity past threshold — interrupt commits.
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

    await closeSession(session);
  });

  it("emits interrupt.onset_to_logic_cancel_ms and stamps interrupt.tts/llm with detected onset", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const onsetMetrics: Array<{ name: string; value: string }> = [];
    const ttsInterrupts: InterruptTtsPacket[] = [];
    const llmInterrupts: InterruptLlmPacket[] = [];

    await session.start();
    session.bus.on("metric.conversation", (pkt) => {
      const metric = pkt as unknown as { name: string; value: string };
      if (metric.name === "interrupt.onset_to_logic_cancel_ms") onsetMetrics.push(metric);
    });
    session.bus.on("interrupt.tts", (pkt) => {
      ttsInterrupts.push(pkt as InterruptTtsPacket);
    });
    session.bus.on("interrupt.llm", (pkt) => {
      llmInterrupts.push(pkt as InterruptLlmPacket);
    });

    const onset = 1_700_000_000_000;
    session.bus.push(Route.Critical, {
      kind: "interrupt.detected",
      contextId: "assistant-turn",
      timestampMs: onset,
      source: "vad",
    } satisfies InterruptionDetectedPacket);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(onsetMetrics).toEqual([
      expect.objectContaining({
        name: "interrupt.onset_to_logic_cancel_ms",
        value: expect.stringMatching(/^\d+$/),
      }),
    ]);
    expect(Number(onsetMetrics[0]!.value)).toBeGreaterThanOrEqual(0);
    expect(ttsInterrupts).toEqual([
      expect.objectContaining({ kind: "interrupt.tts", contextId: "assistant-turn", timestampMs: onset }),
    ]);
    expect(llmInterrupts).toEqual([
      expect.objectContaining({ kind: "interrupt.llm", contextId: "assistant-turn", timestampMs: onset }),
    ]);

    await closeSession(session);
  });

  it("keeps the assistant interruptible after tts.end until its audio finishes playing out", async () => {
    // TTS streams faster than realtime: a chunk representing ~800ms of audio can
    // arrive (and tts.end fire) within a few ms. The assistant is still audibly
    // playing for the remaining ~800ms, so a barge-in in that window must still
    // interrupt it — the speaking state is keyed on playout, not generation.
    const session = new VoiceAgentSession({ plugins: {}, minInterruptionMs: 0 });
    const interrupts: InterruptTtsPacket[] = [];

    await session.start();
    session.bus.on("interrupt.tts", (pkt) => {
      interrupts.push(pkt as InterruptTtsPacket);
    });

    // 25600 bytes @ 16 kHz s16 = 800ms of playout, delivered as one burst.
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "assistant-turn",
      timestampMs: Date.now(),
      audio: new Uint8Array(25600),
      sampleRateHz: 16000,
    } satisfies TextToSpeechAudioPacket);
    session.bus.push(Route.Main, {
      kind: "tts.end",
      contextId: "assistant-turn",
      timestampMs: Date.now(),
    } satisfies TextToSpeechEndPacket);
    // Well inside the 800ms playout window — the assistant is still talking.
    await new Promise((resolve) => setTimeout(resolve, 60));

    session.bus.push(Route.Main, {
      kind: "vad.speech_started",
      contextId: "user",
      timestampMs: Date.now(),
      confidence: 0.99,
    } satisfies VadSpeechStartedPacket);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(interrupts).toEqual([
      expect.objectContaining({ kind: "interrupt.tts", contextId: "assistant-turn" }),
    ]);

    await closeSession(session);
  });

  it("releases the assistant context once its playout estimate elapses", async () => {
    const session = new VoiceAgentSession({ plugins: {}, minInterruptionMs: 0 });
    const interrupts: InterruptTtsPacket[] = [];

    await session.start();
    session.bus.on("interrupt.tts", (pkt) => {
      interrupts.push(pkt as InterruptTtsPacket);
    });

    // 3200 bytes @ 16 kHz s16 = 100ms of playout.
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "assistant-turn",
      timestampMs: Date.now(),
      audio: new Uint8Array(3200),
      sampleRateHz: 16000,
    } satisfies TextToSpeechAudioPacket);
    session.bus.push(Route.Main, {
      kind: "tts.end",
      contextId: "assistant-turn",
      timestampMs: Date.now(),
    } satisfies TextToSpeechEndPacket);
    // Past the 100ms playout window — the assistant has finished speaking.
    await new Promise((resolve) => setTimeout(resolve, 250));

    session.bus.push(Route.Main, {
      kind: "vad.speech_started",
      contextId: "user",
      timestampMs: Date.now(),
      confidence: 0.99,
    } satisfies VadSpeechStartedPacket);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(interrupts).toEqual([]);

    await closeSession(session);
  });

  it("keeps the context interruptible past the duration estimate while the transport reports active playout", async () => {
    // A paced transport reports real playout; under send-buffer backpressure the
    // audio plays longer than its sample-duration. The estimate must defer to the
    // transport so barge-in stays armed for the real playout window.
    const session = new VoiceAgentSession({ plugins: {}, minInterruptionMs: 0 });
    const interrupts: InterruptTtsPacket[] = [];

    await session.start();
    session.bus.on("interrupt.tts", (pkt) => {
      interrupts.push(pkt as InterruptTtsPacket);
    });

    // 3200 bytes @ 16 kHz s16 = 100ms estimate.
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "assistant-turn",
      timestampMs: Date.now(),
      audio: new Uint8Array(3200),
      sampleRateHz: 16000,
    } satisfies TextToSpeechAudioPacket);
    session.bus.push(Route.Main, {
      kind: "tts.end",
      contextId: "assistant-turn",
      timestampMs: Date.now(),
    } satisfies TextToSpeechEndPacket);
    // Transport is still pacing this context (not complete) — real playout ongoing.
    session.bus.push(Route.Main, {
      kind: "tts.playout_progress",
      contextId: "assistant-turn",
      timestampMs: Date.now(),
      playedOutMs: 40,
      complete: false,
    } satisfies TextToSpeechPlayoutProgressPacket);
    // Past the 100ms estimate, but the transport has not reported completion.
    await new Promise((resolve) => setTimeout(resolve, 200));

    session.bus.push(Route.Main, {
      kind: "vad.speech_started",
      contextId: "user",
      timestampMs: Date.now(),
      confidence: 0.99,
    } satisfies VadSpeechStartedPacket);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(interrupts).toEqual([
      expect.objectContaining({ kind: "interrupt.tts", contextId: "assistant-turn" }),
    ]);

    await closeSession(session);
  });

  it("releases the assistant context when the transport reports playout complete", async () => {
    const session = new VoiceAgentSession({ plugins: {}, minInterruptionMs: 0 });
    const interrupts: InterruptTtsPacket[] = [];

    await session.start();
    session.bus.on("interrupt.tts", (pkt) => {
      interrupts.push(pkt as InterruptTtsPacket);
    });

    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "assistant-turn",
      timestampMs: Date.now(),
      audio: new Uint8Array(25600),
      sampleRateHz: 16000,
    } satisfies TextToSpeechAudioPacket);
    session.bus.push(Route.Main, {
      kind: "tts.end",
      contextId: "assistant-turn",
      timestampMs: Date.now(),
    } satisfies TextToSpeechEndPacket);
    // Transport confirms the audio finished playing out (authoritative).
    session.bus.push(Route.Main, {
      kind: "tts.playout_progress",
      contextId: "assistant-turn",
      timestampMs: Date.now(),
      playedOutMs: 800,
      complete: true,
    } satisfies TextToSpeechPlayoutProgressPacket);
    await new Promise((resolve) => setTimeout(resolve, 20));

    session.bus.push(Route.Main, {
      kind: "vad.speech_started",
      contextId: "user",
      timestampMs: Date.now(),
      confidence: 0.99,
    } satisfies VadSpeechStartedPacket);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(interrupts).toEqual([]);

    await closeSession(session);
  });

  it("suppresses a short speech blip during playback without interrupting the agent", async () => {
    const session = new VoiceAgentSession({ plugins: {}, minInterruptionMs: 280 });
    const interrupts: InterruptTtsPacket[] = [];
    const metrics: string[] = [];

    await session.start();
    session.bus.on("interrupt.tts", (pkt) => {
      interrupts.push(pkt as InterruptTtsPacket);
    });
    session.bus.on("metric.conversation", (pkt) => {
      metrics.push((pkt as unknown as { name: string }).name);
    });

    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "assistant-turn",
      timestampMs: Date.now(),
      audio: new Uint8Array([1, 2, 3, 4]),
      sampleRateHz: 16000,
    } satisfies TextToSpeechAudioPacket);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const t0 = Date.now();
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
    // Speech ends before sustaining past the gate — a blip (cough / click / "mhm").
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

  it("emits vaqi.latency_ms once per turn from user stop to first assistant audio", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const metrics: Array<{ name: string; value: string }> = [];

    await session.start();
    session.bus.on("metric.conversation", (pkt) => {
      const m = pkt as unknown as { name: string; value: string };
      if (m.name === "vaqi.latency_ms") metrics.push({ name: m.name, value: m.value });
    });

    const userStoppedMs = 1000;
    session.bus.push(Route.Main, {
      kind: "vad.speech_ended",
      contextId: "turn-1",
      timestampMs: userStoppedMs,
    } satisfies VadSpeechEndedPacket);

    const firstAudioMs = 1350;
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "turn-1",
      timestampMs: firstAudioMs,
      audio: new Uint8Array([1, 2, 3, 4]),
      sampleRateHz: 16000,
    } satisfies TextToSpeechAudioPacket);

    // Second audio packet for same turn — must NOT emit a second latency metric.
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "turn-1",
      timestampMs: firstAudioMs + 50,
      audio: new Uint8Array([5, 6, 7, 8]),
      sampleRateHz: 16000,
    } satisfies TextToSpeechAudioPacket);

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(metrics).toEqual([{ name: "vaqi.latency_ms", value: "350" }]);

    await closeSession(session);
  });

  it("emits vaqi.interruption and interrupt.latency_ms when a barge-in is committed via the gate", async () => {
    const session = new VoiceAgentSession({ plugins: {}, minInterruptionMs: 200 });
    const metrics: Array<{ name: string; value: string }> = [];

    await session.start();
    session.bus.on("metric.conversation", (pkt) => {
      const m = pkt as unknown as { name: string; value: string };
      if (m.name === "vaqi.interruption" || m.name === "interrupt.latency_ms") {
        metrics.push({ name: m.name, value: m.value });
      }
    });

    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "assistant-turn",
      timestampMs: Date.now(),
      audio: new Uint8Array([1, 2, 3, 4]),
      sampleRateHz: 16000,
    } satisfies TextToSpeechAudioPacket);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const t0 = 5000;
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

    expect(metrics).toContainEqual({ name: "vaqi.interruption", value: "1" });
    expect(metrics).toContainEqual({ name: "interrupt.latency_ms", value: "300" });

    await closeSession(session);
  });

  it("emits vaqi.interruption immediately when the interruption gate is disabled", async () => {
    const session = new VoiceAgentSession({ plugins: {}, minInterruptionMs: 0 });
    const metrics: Array<{ name: string; value: string }> = [];

    await session.start();
    session.bus.on("metric.conversation", (pkt) => {
      const m = pkt as unknown as { name: string; value: string };
      if (m.name === "vaqi.interruption") metrics.push({ name: m.name, value: m.value });
    });

    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "assistant-turn",
      timestampMs: Date.now(),
      audio: new Uint8Array([1, 2, 3, 4]),
      sampleRateHz: 16000,
    } satisfies TextToSpeechAudioPacket);
    await new Promise((resolve) => setTimeout(resolve, 10));

    session.bus.push(Route.Main, {
      kind: "vad.speech_started",
      contextId: "user-barge-in",
      timestampMs: Date.now(),
      confidence: 0.99,
    } satisfies VadSpeechStartedPacket);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(metrics).toEqual([{ name: "vaqi.interruption", value: "1" }]);

    await closeSession(session);
  });

  it("emits vaqi.missed_response when no assistant audio arrives within the window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);

    const session = new VoiceAgentSession({
      plugins: {},
      vaqiMissedResponseMs: 2000,
    });
    const metrics: Array<{ name: string; value: string }> = [];

    await session.start();
    session.bus.on("metric.conversation", (pkt) => {
      const m = pkt as unknown as { name: string; value: string };
      if (m.name === "vaqi.missed_response") metrics.push({ name: m.name, value: m.value });
    });

    try {
      session.bus.push(Route.Main, {
        kind: "vad.speech_ended",
        contextId: "turn-1",
        timestampMs: Date.now(),
      } satisfies VadSpeechEndedPacket);
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(1999);
      expect(metrics).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      expect(metrics).toHaveLength(1);
      expect(metrics[0]!.name).toBe("vaqi.missed_response");
      expect(Number(metrics[0]!.value)).toBeGreaterThanOrEqual(2000);
    } finally {
      vi.useRealTimers();
      await closeSession(session);
    }
  });

  it("cancels vaqi.missed_response timer on session close to avoid leaks", async () => {
    const session = new VoiceAgentSession({
      plugins: {},
      vaqiMissedResponseMs: 30,
    });
    const metrics: Array<{ name: string }> = [];

    await session.start();
    session.bus.on("metric.conversation", (pkt) => {
      const m = pkt as unknown as { name: string };
      if (m.name === "vaqi.missed_response") metrics.push({ name: m.name });
    });

    session.bus.push(Route.Main, {
      kind: "vad.speech_ended",
      contextId: "turn-1",
      timestampMs: Date.now(),
    } satisfies VadSpeechEndedPacket);

    await new Promise((resolve) => setTimeout(resolve, 10));
    await session.close();
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(metrics).toEqual([]);

    await closeSession(session);
  });

  it("does not fire a stale barge-in if the assistant finishes during the gate window", async () => {
    const session = new VoiceAgentSession({ plugins: {}, minInterruptionMs: 280 });
    const interrupts: InterruptTtsPacket[] = [];
    const metrics: string[] = [];

    await session.start();
    session.bus.on("interrupt.tts", (pkt) => {
      interrupts.push(pkt as InterruptTtsPacket);
    });
    session.bus.on("metric.conversation", (pkt) => {
      metrics.push((pkt as unknown as { name: string }).name);
    });

    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "assistant-turn",
      timestampMs: Date.now(),
      audio: new Uint8Array([1, 2, 3, 4]),
      sampleRateHz: 16000,
    } satisfies TextToSpeechAudioPacket);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const t0 = Date.now();
    session.bus.push(Route.Main, {
      kind: "vad.speech_started",
      contextId: "user",
      timestampMs: t0,
      confidence: 0.99,
    } satisfies VadSpeechStartedPacket);
    // Assistant finishes speaking before the user's speech sustains past the gate.
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

  it("speaks a graceful fallback when the LLM fails a turn (never fail silently)", async () => {
    const session = new VoiceAgentSession({ plugins: {}, errorFallbackText: "One moment please." });
    const ttsTexts: string[] = [];
    const metrics: string[] = [];
    await session.start();
    session.bus.on("tts.text", (pkt) => {
      ttsTexts.push((pkt as unknown as { text: string }).text);
    });
    session.bus.on("metric.conversation", (pkt) => {
      metrics.push((pkt as unknown as { name: string }).name);
    });

    session.bus.push(Route.Critical, {
      kind: "llm.error",
      contextId: "turn-1",
      timestampMs: Date.now(),
      component: "llm",
      category: ErrorCategory.NetworkTimeout,
      cause: new Error("provider timeout"),
      isRecoverable: true,
    } satisfies LlmErrorPacket);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(metrics).toContain("error.fallback_spoken");
    expect(ttsTexts.join(" ")).toContain("One moment please.");

    await closeSession(session);
  });

  it("does not speak an LLM fallback for a TTS failure (needs canned audio, not the broken TTS)", async () => {
    const session = new VoiceAgentSession({ plugins: {}, errorFallbackText: "One moment please." });
    const metrics: string[] = [];
    await session.start();
    session.bus.on("metric.conversation", (pkt) => {
      metrics.push((pkt as unknown as { name: string }).name);
    });

    session.bus.push(Route.Critical, {
      kind: "tts.error",
      contextId: "turn-1",
      timestampMs: Date.now(),
      component: "tts",
      category: ErrorCategory.NetworkTimeout,
      cause: new Error("tts down"),
      isRecoverable: true,
    } satisfies TtsErrorPacket);

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(metrics).not.toContain("error.fallback_spoken");

    await closeSession(session);
  });

  it("fires the TTS stall watchdog when output goes silent mid-utterance", async () => {
    const session = new VoiceAgentSession({ plugins: {}, ttsStallMs: 30 });
    const metrics: string[] = [];
    const ttsErrors: Array<{ category: string }> = [];
    await session.start();
    session.bus.on("metric.conversation", (pkt) => {
      metrics.push((pkt as unknown as { name: string }).name);
    });
    session.bus.on("tts.error", (pkt) => {
      ttsErrors.push({ category: (pkt as unknown as { category: string }).category });
    });

    // TTS produces one chunk then goes silent — no further audio, no tts.end.
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "turn-1",
      timestampMs: Date.now(),
      audio: new Uint8Array([1, 2, 3, 4]),
      sampleRateHz: 16000,
    } satisfies TextToSpeechAudioPacket);

    await new Promise((resolve) => setTimeout(resolve, 90)); // > ttsStallMs

    expect(metrics).toContain("tts.stall_detected");
    expect(ttsErrors.some((e) => e.category === "network_timeout")).toBe(true);

    await closeSession(session);
  });

  it("does not fire the TTS stall watchdog when tts.end arrives", async () => {
    const session = new VoiceAgentSession({ plugins: {}, ttsStallMs: 30 });
    const metrics: string[] = [];
    await session.start();
    session.bus.on("metric.conversation", (pkt) => {
      metrics.push((pkt as unknown as { name: string }).name);
    });

    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "turn-1",
      timestampMs: Date.now(),
      audio: new Uint8Array([1, 2, 3, 4]),
      sampleRateHz: 16000,
    } satisfies TextToSpeechAudioPacket);
    await new Promise((resolve) => setTimeout(resolve, 10));
    session.bus.push(Route.Main, {
      kind: "tts.end",
      contextId: "turn-1",
      timestampMs: Date.now(),
    } satisfies TextToSpeechEndPacket);
    await new Promise((resolve) => setTimeout(resolve, 60)); // past ttsStallMs

    expect(metrics).not.toContain("tts.stall_detected");

    await closeSession(session);
  });

  it("test:input_stall_emits_recovery — fires recoverable pipeline.error and metric when inbound audio stalls", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);

    const session = new VoiceAgentSession({ plugins: {}, inputCadenceTimeoutMs: 2000 });
    const metrics: string[] = [];
    const pipelineErrors: Array<{ category: string; isRecoverable: boolean; message: string }> = [];

    await session.start();
    session.bus.on("metric.conversation", (pkt) => {
      metrics.push((pkt as unknown as { name: string }).name);
    });
    session.bus.on("pipeline.error", (pkt) => {
      const err = pkt as PipelineErrorPacket;
      pipelineErrors.push({
        category: err.category,
        isRecoverable: err.isRecoverable,
        message: err.cause.message,
      });
    });

    try {
      session.bus.push(Route.Main, {
        kind: "user.audio_received",
        contextId: "turn-1",
        timestampMs: Date.now(),
        audio: new Uint8Array([1, 2, 3, 4]),
      } satisfies UserAudioReceivedPacket);
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(1999);
      expect(metrics).not.toContain("input.cadence_stall_ms");
      expect(pipelineErrors).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      expect(metrics).toContain("input.cadence_stall_ms");
      expect(pipelineErrors).toEqual([
        expect.objectContaining({
          category: "network_timeout",
          isRecoverable: true,
          message: "inbound audio stalled",
        }),
      ]);
    } finally {
      vi.useRealTimers();
      await closeSession(session);
    }
  });

  it("test:cadence_reset_on_audio — inbound audio before the window resets the cadence watchdog", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);

    const session = new VoiceAgentSession({ plugins: {}, inputCadenceTimeoutMs: 2000 });
    const metrics: string[] = [];
    const pipelineErrors: PipelineErrorPacket[] = [];

    await session.start();
    session.bus.on("metric.conversation", (pkt) => {
      metrics.push((pkt as unknown as { name: string }).name);
    });
    session.bus.on("pipeline.error", (pkt) => {
      pipelineErrors.push(pkt as PipelineErrorPacket);
    });

    try {
      session.bus.push(Route.Main, {
        kind: "user.audio_received",
        contextId: "turn-1",
        timestampMs: Date.now(),
        audio: new Uint8Array([1, 2, 3, 4]),
      } satisfies UserAudioReceivedPacket);
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(1500);
      session.bus.push(Route.Main, {
        kind: "user.audio_received",
        contextId: "turn-1",
        timestampMs: Date.now(),
        audio: new Uint8Array([5, 6, 7, 8]),
      } satisfies UserAudioReceivedPacket);
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(1999);
      expect(metrics).not.toContain("input.cadence_stall_ms");
      expect(pipelineErrors).toEqual([]);
    } finally {
      vi.useRealTimers();
      await closeSession(session);
    }
  });

  it("does not arm the input cadence watchdog when inputCadenceTimeoutMs is 0", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);

    const session = new VoiceAgentSession({ plugins: {} });
    const metrics: string[] = [];
    const pipelineErrors: PipelineErrorPacket[] = [];

    await session.start();
    session.bus.on("metric.conversation", (pkt) => {
      metrics.push((pkt as unknown as { name: string }).name);
    });
    session.bus.on("pipeline.error", (pkt) => {
      pipelineErrors.push(pkt as PipelineErrorPacket);
    });

    try {
      session.bus.push(Route.Main, {
        kind: "user.audio_received",
        contextId: "turn-1",
        timestampMs: Date.now(),
        audio: new Uint8Array([1, 2, 3, 4]),
      } satisfies UserAudioReceivedPacket);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(metrics).not.toContain("input.cadence_stall_ms");
      expect(pipelineErrors).toEqual([]);
    } finally {
      vi.useRealTimers();
      await closeSession(session);
    }
  });

  it("tells the recorder to truncate queued assistant audio on barge-in", async () => {
    const session = new VoiceAgentSession({ plugins: {}, minInterruptionMs: 0 });
    const recorded: RecordAssistantAudioPacket[] = [];

    await session.start();
    session.bus.on("record.assistant_audio", (pkt) => {
      recorded.push(pkt as RecordAssistantAudioPacket);
    });

    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "assistant-turn",
      timestampMs: Date.now(),
      audio: new Uint8Array([1, 2, 3, 4]),
      sampleRateHz: 16000,
    } satisfies TextToSpeechAudioPacket);
    await new Promise((resolve) => setTimeout(resolve, 20));

    session.bus.push(Route.Main, {
      kind: "vad.speech_started",
      contextId: "user-barge-in",
      timestampMs: Date.now(),
      confidence: 0.99,
    } satisfies VadSpeechStartedPacket);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(recorded).toEqual([
      expect.objectContaining({
        kind: "record.assistant_audio",
        contextId: "assistant-turn",
        truncate: false,
      }),
      expect.objectContaining({
        kind: "record.assistant_audio",
        contextId: "assistant-turn",
        truncate: true,
        audio: new Uint8Array(0),
      }),
    ]);

    await closeSession(session);
  });

  it("does not reopen TTS from late LLM or TTS packets after barge-in", async () => {
    const session = new VoiceAgentSession({ plugins: {}, minInterruptionMs: 0 });
    const ttsText: TextToSpeechTextPacket[] = [];
    const ttsDone: TextToSpeechDonePacket[] = [];
    const recorded: RecordAssistantAudioPacket[] = [];
    const metrics: string[] = [];

    await session.start();
    session.bus.on("tts.text", (pkt) => {
      ttsText.push(pkt as TextToSpeechTextPacket);
    });
    session.bus.on("tts.done", (pkt) => {
      ttsDone.push(pkt as TextToSpeechDonePacket);
    });
    session.bus.on("record.assistant_audio", (pkt) => {
      recorded.push(pkt as RecordAssistantAudioPacket);
    });
    session.bus.on("metric.conversation", (pkt) => {
      const metric = pkt as unknown as { name: string };
      metrics.push(metric.name);
    });

    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "assistant-turn",
      timestampMs: Date.now(),
      audio: new Uint8Array([1, 2, 3, 4]),
      sampleRateHz: 16000,
    } satisfies TextToSpeechAudioPacket);
    await new Promise((resolve) => setTimeout(resolve, 20));

    session.bus.push(Route.Main, {
      kind: "vad.speech_started",
      contextId: "user-barge-in",
      timestampMs: Date.now(),
      confidence: 0.99,
    } satisfies VadSpeechStartedPacket);
    await new Promise((resolve) => setTimeout(resolve, 20));

    session.bus.push(Route.Main, {
      kind: "llm.delta",
      contextId: "assistant-turn",
      timestampMs: Date.now(),
      text: " This late text must not be spoken.",
    } satisfies LlmDeltaPacket);
    session.bus.push(Route.Main, {
      kind: "llm.done",
      contextId: "assistant-turn",
      timestampMs: Date.now(),
      text: "This late done must not flush TTS.",
    } satisfies LlmResponseDonePacket);
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "assistant-turn",
      timestampMs: Date.now(),
      audio: new Uint8Array([5, 6, 7, 8]),
      sampleRateHz: 16000,
    } satisfies TextToSpeechAudioPacket);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(ttsText).toEqual([]);
    expect(ttsDone).toEqual([]);
    expect(recorded).toEqual([
      expect.objectContaining({
        contextId: "assistant-turn",
        truncate: false,
        audio: new Uint8Array([1, 2, 3, 4]),
      }),
      expect.objectContaining({
        contextId: "assistant-turn",
        truncate: true,
        audio: new Uint8Array(0),
      }),
    ]);
    expect(metrics).toContain("llm.delta_ignored_after_interrupt");
    expect(metrics).toContain("llm.done_ignored_after_interrupt");
    expect(metrics).toContain("tts.audio_ignored_after_interrupt");

    await closeSession(session);
  });

  it("suppresses sustained bystander barge-in when a primary speaker profile is enrolled", async () => {
    const session = new VoiceAgentSession({ plugins: {}, minInterruptionMs: 280 });
    const interrupts: InterruptTtsPacket[] = [];
    const metrics: string[] = [];

    await session.start();
    session.bus.on("interrupt.tts", (pkt) => {
      interrupts.push(pkt as InterruptTtsPacket);
    });
    session.bus.on("metric.conversation", (pkt) => {
      metrics.push((pkt as unknown as { name: string }).name);
    });

    await enrollPrimarySpeaker(session);

    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "assistant-turn",
      timestampMs: Date.now(),
      audio: synthesizeTonePcm16({
        frequencyHz: ASSISTANT_ECHO_TONE_HZ,
        durationMs: 32,
      }),
      sampleRateHz: 16000,
    } satisfies TextToSpeechAudioPacket);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const bystander = synthesizeTonePcm16({
      frequencyHz: BYSTANDER_SPEAKER_TONE_HZ,
      durationMs: 32,
    });
    const t0 = Date.now();
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

  it("commits a primary-speaker barge-in composed with the G1 time gate", async () => {
    const session = new VoiceAgentSession({ plugins: {}, minInterruptionMs: 280 });
    const interrupts: InterruptTtsPacket[] = [];

    await session.start();
    session.bus.on("interrupt.tts", (pkt) => {
      interrupts.push(pkt as InterruptTtsPacket);
    });

    await enrollPrimarySpeaker(session);

    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "assistant-turn",
      timestampMs: Date.now(),
      audio: new Uint8Array([1, 2, 3, 4]),
      sampleRateHz: 16000,
    } satisfies TextToSpeechAudioPacket);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const primary = synthesizeTonePcm16({
      frequencyHz: PRIMARY_SPEAKER_TONE_HZ,
      durationMs: 32,
    });
    const t0 = Date.now();
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
        audio: primary,
      } satisfies VadAudioPacket);
    }
    session.bus.push(Route.Main, {
      kind: "vad.speech_activity",
      contextId: "user-barge",
      timestampMs: t0 + 320,
      isAsync: true,
    } satisfies VadSpeechActivityPacket);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(interrupts).toEqual([
      expect.objectContaining({ kind: "interrupt.tts", contextId: "assistant-turn" }),
    ]);

    await closeSession(session);
  });

  it("preserves G1-only barge-in when no primary speaker profile is enrolled", async () => {
    const session = new VoiceAgentSession({ plugins: {}, minInterruptionMs: 280 });
    const interrupts: InterruptTtsPacket[] = [];
    const metrics: string[] = [];

    await session.start();
    session.bus.on("interrupt.tts", (pkt) => {
      interrupts.push(pkt as InterruptTtsPacket);
    });
    session.bus.on("metric.conversation", (pkt) => {
      metrics.push((pkt as unknown as { name: string }).name);
    });

    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "assistant-turn",
      timestampMs: Date.now(),
      audio: new Uint8Array([1, 2, 3, 4]),
      sampleRateHz: 16000,
    } satisfies TextToSpeechAudioPacket);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const t0 = Date.now();
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
    expect(metrics).not.toContain("interrupt.suppressed_non_primary");

    await closeSession(session);
  });

  it("enqueues filler TTS at endpoint before the first LLM token when enabled", async () => {
    const session = new VoiceAgentSession({
      plugins: {},
      latencyFillerEnabled: true,
    });
    const ttsText: TextToSpeechTextPacket[] = [];
    const metrics: string[] = [];

    await session.start();
    session.bus.on("tts.text", (pkt) => {
      ttsText.push(pkt as TextToSpeechTextPacket);
    });
    session.bus.on("metric.conversation", (pkt) => {
      metrics.push((pkt as unknown as { name: string }).name);
    });

    session.bus.push(Route.Main, {
      kind: "eos.turn_complete",
      contextId: "turn-1",
      timestampMs: 1000,
      text: "Can I add Biology 101?",
      transcripts: [],
    } satisfies EndOfSpeechPacket);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(ttsText).toEqual([
      expect.objectContaining({
        kind: "tts.text",
        contextId: "turn-1",
        text: "Well,",
      }),
    ]);
    expect(metrics).toContain("filler.started");

    session.bus.push(Route.Main, {
      kind: "llm.delta",
      contextId: "turn-1",
      timestampMs: 1500,
      text: "You can still submit a late add petition.",
    } satisfies LlmDeltaPacket);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(ttsText).toEqual([
      expect.objectContaining({ text: "Well," }),
      expect.objectContaining({ text: "You can still submit a late add petition." }),
    ]);
    expect(metrics).toContain("filler.spliced");

    await closeSession(session);
  });

  it("cancels filler when the user keeps talking after endpoint", async () => {
    const session = new VoiceAgentSession({
      plugins: {},
      latencyFillerEnabled: true,
    });
    const interrupts: InterruptTtsPacket[] = [];
    const metrics: string[] = [];

    await session.start();
    session.bus.on("interrupt.tts", (pkt) => {
      interrupts.push(pkt as InterruptTtsPacket);
    });
    session.bus.on("metric.conversation", (pkt) => {
      metrics.push((pkt as unknown as { name: string }).name);
    });

    session.bus.push(Route.Main, {
      kind: "eos.turn_complete",
      contextId: "turn-1",
      timestampMs: 1000,
      text: "I need help with",
      transcripts: [],
    } satisfies EndOfSpeechPacket);
    await new Promise((resolve) => setTimeout(resolve, 10));

    session.bus.push(Route.Main, {
      kind: "vad.speech_started",
      contextId: "turn-1",
      timestampMs: 1100,
      confidence: 0.99,
    } satisfies VadSpeechStartedPacket);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(interrupts).toEqual([
      expect.objectContaining({ kind: "interrupt.tts", contextId: "turn-1" }),
    ]);
    expect(metrics).toContain("filler.cancelled");

    await closeSession(session);
  });

  it("clears latency filler state on recoverable component errors", async () => {
    const session = new VoiceAgentSession({
      plugins: {},
      latencyFillerEnabled: true,
    });
    await session.start();

    session.bus.push(Route.Main, {
      kind: "eos.turn_complete",
      contextId: "turn-error-clear",
      timestampMs: 1000,
      text: "hello",
      transcripts: [],
    } satisfies EndOfSpeechPacket);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(session["latencyFiller"].getState("turn-error-clear")).toBeDefined();

    session.bus.push(Route.Main, {
      kind: "llm.error",
      contextId: "turn-error-clear",
      timestampMs: 1100,
      component: "llm",
      category: ErrorCategory.NetworkTimeout,
      cause: new Error("provider down"),
      isRecoverable: true,
    } satisfies LlmErrorPacket);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(session["latencyFiller"].getState("turn-error-clear")).toBeUndefined();

    await closeSession(session);
  });

  it("splices filler into the real response without duplicating connectives", async () => {
    const session = new VoiceAgentSession({
      plugins: {},
      latencyFillerEnabled: true,
    });
    const ttsText: TextToSpeechTextPacket[] = [];

    await session.start();
    session.bus.on("tts.text", (pkt) => {
      ttsText.push(pkt as TextToSpeechTextPacket);
    });

    session.bus.push(Route.Main, {
      kind: "eos.turn_complete",
      contextId: "turn-1",
      timestampMs: 1000,
      text: "hello",
      transcripts: [],
    } satisfies EndOfSpeechPacket);

    session.bus.push(Route.Main, {
      kind: "llm.delta",
      contextId: "turn-1",
      timestampMs: 1400,
      text: "So the petition is still open.",
    } satisfies LlmDeltaPacket);
    session.bus.push(Route.Main, {
      kind: "llm.done",
      contextId: "turn-1",
      timestampMs: 1401,
      text: "So the petition is still open.",
    } satisfies LlmResponseDonePacket);

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(ttsText.map((pkt) => pkt.text)).toEqual([
      "So,",
      "the petition is still open.",
    ]);

    await closeSession(session);
  });

  describe("endpointingOwner invariant (VE-02)", () => {
    it("throws for unsupported endpointingOwner in constructor", () => {
      expect(
        () =>
          new VoiceAgentSession({
            plugins: {},
            endpointingOwner: "bogus" as "provider_stt",
          }),
      ).toThrow("Unsupported endpointingOwner: bogus");
    });

    it("with owner unset defaults to provider STT and does not fan user audio to eos.audio", async () => {
      const session = new VoiceAgentSession({ plugins: {} });
      await session.start();

      const eosPackets: EndOfSpeechAudioPacket[] = [];
      const sttPackets: SpeechToTextAudioPacket[] = [];
      session.bus.on("eos.audio", (pkt) => {
        eosPackets.push(pkt as EndOfSpeechAudioPacket);
      });
      session.bus.on("stt.audio", (pkt) => {
        sttPackets.push(pkt as SpeechToTextAudioPacket);
      });

      session.bus.push(Route.Main, {
        kind: "user.audio_received",
        contextId: "turn-default-owner",
        timestampMs: Date.now(),
        audio: new Uint8Array([1, 2, 3]),
      } satisfies UserAudioReceivedPacket);

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sttPackets).toHaveLength(1);
      expect(eosPackets).toHaveLength(0);

      await closeSession(session);
    });

    it("with provider_stt owner does not fan eos.audio but routes EOS to one user.input", async () => {
      const session = new VoiceAgentSession({
        plugins: {},
        endpointingOwner: "provider_stt",
      });
      const eosPackets: EndOfSpeechAudioPacket[] = [];
      const userInputs: UserInputPacket[] = [];

      await session.start();
      session.bus.on("eos.audio", (pkt) => {
        eosPackets.push(pkt as EndOfSpeechAudioPacket);
      });
      session.bus.on("user.input", (pkt) => {
        userInputs.push(pkt as UserInputPacket);
      });

      session.bus.push(Route.Main, {
        kind: "user.audio_received",
        contextId: "turn-stt",
        timestampMs: Date.now(),
        audio: new Uint8Array([9, 8, 7]),
      } satisfies UserAudioReceivedPacket);

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(eosPackets).toHaveLength(0);

      session.bus.push(Route.Main, {
        kind: "eos.turn_complete",
        contextId: "turn-stt",
        timestampMs: Date.now(),
        text: "from provider",
        transcripts: [],
      } satisfies EndOfSpeechPacket);

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(userInputs).toHaveLength(1);
      expect(userInputs[0]!.text).toBe("from provider");

      await closeSession(session);
    });

    it("allows multiple user turns with the same stable transport contextId", async () => {
      const session = new VoiceAgentSession({
        plugins: {},
        endpointingOwner: "provider_stt",
      });
      const userInputs: UserInputPacket[] = [];
      const finals: Array<{ turnId: string; text: string }> = [];

      await session.start();
      session.bus.on("user.input", (pkt) => {
        userInputs.push(pkt as UserInputPacket);
      });
      session.on("user_input_final", (event) => {
        finals.push({ turnId: event.turnId, text: event.text });
      });

      session.bus.push(Route.Main, {
        kind: "vad.speech_started",
        contextId: "call-stable",
        timestampMs: 1000,
        confidence: 0.99,
      } satisfies VadSpeechStartedPacket);
      session.bus.push(Route.Main, {
        kind: "eos.turn_complete",
        contextId: "call-stable",
        timestampMs: 1100,
        text: "first turn",
        transcripts: [],
      } satisfies EndOfSpeechPacket);
      await new Promise((resolve) => setTimeout(resolve, 20));

      session.bus.push(Route.Main, {
        kind: "vad.speech_started",
        contextId: "call-stable",
        timestampMs: 2000,
        confidence: 0.99,
      } satisfies VadSpeechStartedPacket);
      session.bus.push(Route.Main, {
        kind: "eos.turn_complete",
        contextId: "call-stable",
        timestampMs: 2100,
        text: "second turn",
        transcripts: [],
      } satisfies EndOfSpeechPacket);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(userInputs.map((pkt) => pkt.text)).toEqual(["first turn", "second turn"]);
      expect(finals).toEqual([
        { turnId: "call-stable", text: "first turn" },
        { turnId: "call-stable", text: "second turn" },
      ]);

      await closeSession(session);
    });

    it("re-arms per-turn guard state across a barge-in on a stable contextId (no stale interrupt-drop; emits interrupt.stt)", async () => {
      const session = new VoiceAgentSession({
        plugins: {},
        endpointingOwner: "provider_stt",
        minInterruptionMs: 0,
      });
      const ignoredAfterInterrupt: string[] = [];
      const sttInterrupts: string[] = [];

      await session.start();
      session.bus.on("metric.conversation", (pkt) => {
        const m = pkt as { name?: string };
        if (m.name === "llm.delta_ignored_after_interrupt") ignoredAfterInterrupt.push(m.name);
      });
      session.bus.on("interrupt.stt", (pkt) => {
        sttInterrupts.push((pkt as { contextId: string }).contextId);
      });

      // Turn 1 on a stable (telephony-style) contextId, then a barge-in during its response.
      session.bus.push(Route.Main, {
        kind: "vad.speech_started",
        contextId: "call-stable",
        timestampMs: 1000,
        confidence: 0.99,
      } satisfies VadSpeechStartedPacket);
      session.bus.push(Route.Main, {
        kind: "eos.turn_complete",
        contextId: "call-stable",
        timestampMs: 1100,
        text: "first turn",
        transcripts: [],
      } satisfies EndOfSpeechPacket);
      await new Promise((resolve) => setTimeout(resolve, 20));
      session.bus.push(Route.Critical, {
        kind: "interrupt.detected",
        contextId: "call-stable",
        timestampMs: 1200,
        source: "vad",
      } satisfies InterruptionDetectedPacket);
      await new Promise((resolve) => setTimeout(resolve, 20));

      // interrupt.stt is now emitted on barge-in so provider STT resets transcript state.
      expect(sttInterrupts).toContain("call-stable");

      // Turn 2 reuses the SAME contextId. Before the fix, the stale interrupted-generation
      // flag from turn 1 dropped turn 2's llm.delta as "llm.delta_ignored_after_interrupt".
      session.bus.push(Route.Main, {
        kind: "vad.speech_started",
        contextId: "call-stable",
        timestampMs: 2000,
        confidence: 0.99,
      } satisfies VadSpeechStartedPacket);
      session.bus.push(Route.Main, {
        kind: "eos.turn_complete",
        contextId: "call-stable",
        timestampMs: 2100,
        text: "second turn",
        transcripts: [],
      } satisfies EndOfSpeechPacket);
      await new Promise((resolve) => setTimeout(resolve, 20));
      session.bus.push(Route.Main, {
        kind: "llm.delta",
        contextId: "call-stable",
        timestampMs: 2200,
        text: "second turn reply",
      } satisfies LlmDeltaPacket);
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Turn 2's response is NOT suppressed by turn 1's barge-in.
      expect(ignoredAfterInterrupt).toEqual([]);

      await closeSession(session);
    });

    it("initializes only the provider finalizer when provider_stt owns endpointing", async () => {
      const provider = new EndpointingPlugin({
        owner: "provider_stt",
        disableConfig: { emit_eos_on_final: false },
      });
      const smartTurn = new EndpointingPlugin({ owner: "smart_turn" });
      const session = new VoiceAgentSession({
        plugins: {
          stt: { emit_eos_on_final: true },
          eos: {},
        },
        endpointingOwner: "provider_stt",
      });
      session.registerPlugin("stt", provider);
      session.registerPlugin("eos", smartTurn);

      await session.start();

      expect(provider.initializeCount).toBe(1);
      expect(provider.config).toEqual({ emit_eos_on_final: true });
      expect(smartTurn.initializeCount).toBe(0);

      await closeSession(session);
    });

    it("forces provider EOS off while keeping STT initialized when smart_turn owns endpointing", async () => {
      const provider = new EndpointingPlugin({
        owner: "provider_stt",
        disableConfig: {
          emit_eos_on_final: false,
          finalize_on_speech_final: false,
        },
      });
      const smartTurn = new EndpointingPlugin({ owner: "smart_turn" });
      const session = new VoiceAgentSession({
        plugins: {
          stt: { emit_eos_on_final: true, finalize_on_speech_final: true },
          eos: {},
        },
        endpointingOwner: "smart_turn",
      });
      session.registerPlugin("stt", provider);
      session.registerPlugin("eos", smartTurn);

      await session.start();

      expect(provider.initializeCount).toBe(1);
      expect(provider.config).toEqual({
        emit_eos_on_final: false,
        finalize_on_speech_final: false,
      });
      expect(smartTurn.initializeCount).toBe(1);

      await closeSession(session);
    });

    it("throws at startup when the selected endpointing owner has multiple finalizers", async () => {
      const session = new VoiceAgentSession({
        plugins: { sttA: {}, sttB: {} },
        endpointingOwner: "provider_stt",
      });
      session.registerPlugin("sttA", new EndpointingPlugin({ owner: "provider_stt" }));
      session.registerPlugin("sttB", new EndpointingPlugin({ owner: "provider_stt" }));

      await expect(session.start()).rejects.toThrow(
        "endpointingOwner=provider_stt requires exactly one registered provider_stt EOS finalizer; found 2",
      );
      await closeSession(session);
    });

    it("drops duplicate eos.turn_complete for same contextId with eos.duplicate_dropped metric", async () => {
      const session = new VoiceAgentSession({ plugins: {} });
      const userInputs: UserInputPacket[] = [];
      const duplicateMetrics: Array<{ name: string; value: string }> = [];

      await session.start();
      session.bus.on("user.input", (pkt) => {
        userInputs.push(pkt as UserInputPacket);
      });
      session.bus.on("metric.conversation", (pkt) => {
        const m = pkt as unknown as { name: string; value: string };
        if (m.name === "eos.duplicate_dropped") {
          duplicateMetrics.push({ name: m.name, value: m.value });
        }
      });

      const eosPacket: EndOfSpeechPacket = {
        kind: "eos.turn_complete",
        contextId: "turn-dup",
        timestampMs: Date.now(),
        text: "once",
        transcripts: [],
      };
      session.bus.push(Route.Main, eosPacket);
      session.bus.push(Route.Main, eosPacket);

      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(userInputs).toHaveLength(1);
      expect(userInputs[0]!.text).toBe("once");
      expect(duplicateMetrics).toEqual([{ name: "eos.duplicate_dropped", value: "1" }]);

      await closeSession(session);
    });
  });
});
