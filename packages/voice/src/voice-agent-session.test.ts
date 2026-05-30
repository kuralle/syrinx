// SPDX-License-Identifier: MIT

import { describe, it, expect, vi } from "vitest";
import { VoiceAgentSession } from "./voice-agent-session.js";
import { Route, type PipelineBus, type PluginConfig, type VoicePlugin } from "./index.js";
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
  TextToSpeechTextPacket,
  InterruptTtsPacket,
  VadSpeechEndedPacket,
  UserAudioReceivedPacket,
  UserInputPacket,
  VadAudioPacket,
  ModeSwitchCompletedPacket,
  VadSpeechStartedPacket,
  VadSpeechActivityPacket,
} from "./packets.js";

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
    const session = new VoiceAgentSession({ plugins: {} });
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
});
