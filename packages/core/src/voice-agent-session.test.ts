// SPDX-License-Identifier: MIT

import { describe, it, expect, vi } from "vitest";
import { VoiceAgentSession, type SessionStageUsage } from "./voice-agent-session.js";
import {
  Route,
  type InteractionDecision,
  type InteractionObservation,
  type InteractionPolicy,
  type PipelineBus,
  type PluginConfig,
  type VoicePlugin,
} from "./index.js";
import { InteractionCoordinator } from "./interaction-coordinator.js";
import { InMemoryMetricsExporter } from "./observability.js";
import type { Scheduler, ScheduledCallback } from "./scheduler.js";
import { ErrorCategory, type InteractionBackchannelPacket } from "./packets.js";
import type {
  EndOfSpeechAudioPacket,
  RecordAssistantAudioPacket,
  RecordUserAudioPacket,
  SpeechToTextAudioPacket,
  SttInterimPacket,
  SttPartialPacket,
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
  AcousticSignalPacket,
  TurnLocalizationPacket,
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

class ContextCapturingBridgePlugin implements VoicePlugin {
  readonly injectedContext: string[] = [];

  async initialize(): Promise<void> {
    // no-op
  }

  injectContext(text: string): void {
    this.injectedContext.push(text);
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

class CapturingInteractionPolicy implements InteractionPolicy {
  readonly observations: InteractionObservation[] = [];
  readonly resetContextIds: string[] = [];
  initializeCount = 0;
  closeCount = 0;
  initializedConfig: Record<string, unknown> | null = null;

  constructor(
    private readonly decide: (observation: InteractionObservation) => readonly InteractionDecision[] = () => [],
  ) {}

  async initialize(config: Record<string, unknown>): Promise<void> {
    this.initializeCount += 1;
    this.initializedConfig = config;
  }

  observe(observation: InteractionObservation): readonly InteractionDecision[] {
    this.observations.push(observation);
    return this.decide(observation);
  }

  reset(contextId: string): void {
    this.resetContextIds.push(contextId);
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

/** Records scheduled/cancelled timers without firing them, for leak assertions. */
class RecordingScheduler implements Scheduler {
  readonly timers = new Map<string, { delayMs: number; cb: ScheduledCallback }>();
  schedule(key: string, delayMs: number, cb: ScheduledCallback): void {
    this.timers.set(key, { delayMs, cb });
  }
  cancel(key: string): void {
    this.timers.delete(key);
  }
  pendingKeys(prefix: string): string[] {
    return [...this.timers.keys()].filter((k) => k.startsWith(prefix));
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
  it("owns an injected policy lifecycle and feeds decoded audio plus playout observations", async () => {
    const policy = new CapturingInteractionPolicy();
    const session = new VoiceAgentSession({
      plugins: {},
      interactionPolicy: policy,
      interactionPolicyConfig: { model_path: "/tmp/policy.onnx" },
    });
    await session.start();

    session.bus.push(Route.Main, {
      kind: "user.audio_received",
      contextId: "turn-policy",
      timestampMs: 1000,
      audio: new Uint8Array([0x34, 0x12, 0xcc, 0xff]),
    } satisfies UserAudioReceivedPacket);
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "turn-policy",
      timestampMs: 1100,
      audio: new Uint8Array(640),
      sampleRateHz: 16000,
    } satisfies TextToSpeechAudioPacket);
    session.bus.push(Route.Main, {
      kind: "tts.playout_progress",
      contextId: "turn-policy",
      timestampMs: 1200,
      playedOutMs: 20,
      complete: true,
    } satisfies TextToSpeechPlayoutProgressPacket);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(policy.initializeCount).toBe(1);
    expect(policy.initializedConfig).toEqual({ model_path: "/tmp/policy.onnx" });
    const audioFrame = policy.observations.find((observation) => observation.kind === "audio_frame");
    expect(audioFrame).toMatchObject({ contextId: "turn-policy", timestampMs: 1000, sampleRateHz: 16000 });
    expect(audioFrame?.kind === "audio_frame" ? [...(audioFrame.audio ?? [])] : []).toEqual([4660, -52]);
    expect(policy.observations.filter((observation) => observation.kind === "playout_tick")).toEqual([
      expect.objectContaining({
        contextId: "turn-policy",
        ttsActive: true,
        sampleRateHz: 16000,
        audio: expect.any(Int16Array),
      }),
      expect.objectContaining({ contextId: "turn-policy", playedOutMs: 20, ttsActive: false }),
    ]);

    await closeSession(session);
    expect(policy.closeCount).toBe(1);
  });

  it("threads the packet's true sample rate to the injected policy audio_frame (not a hardcoded 16k)", async () => {
    const policy = new CapturingInteractionPolicy();
    const session = new VoiceAgentSession({ plugins: {}, interactionPolicy: policy });
    await session.start();

    session.bus.push(Route.Main, {
      kind: "user.audio_received",
      contextId: "turn-rate",
      timestampMs: 2000,
      audio: new Uint8Array([0x34, 0x12, 0xcc, 0xff]),
      sampleRateHz: 24000,
    } satisfies UserAudioReceivedPacket);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const audioFrame = policy.observations.find((o) => o.kind === "audio_frame");
    expect(audioFrame).toMatchObject({ contextId: "turn-rate", sampleRateHz: 24000 });

    await closeSession(session);
  });

  it("cancels a pending interaction playout timer on close even after its turn completed", async () => {
    const scheduler = new RecordingScheduler();
    const policy = new CapturingInteractionPolicy();
    const session = new VoiceAgentSession({ plugins: {}, interactionPolicy: policy, scheduler });
    await session.start();

    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "turn-x",
      timestampMs: 1000,
      audio: new Uint8Array(640),
      sampleRateHz: 16000,
    } satisfies TextToSpeechAudioPacket);
    session.bus.push(Route.Main, {
      kind: "tts.end",
      contextId: "turn-x",
      timestampMs: 1100,
    } satisfies TextToSpeechEndPacket);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(scheduler.pendingKeys("interaction.playout:")).toEqual(["interaction.playout:turn-x"]);

    // Turn completes (telephony reuses the contextId) — this deletes turn-x from
    // firstTtsAudioFired, orphaning the timer from the old stop() cancel loop.
    session.bus.push(Route.Main, {
      kind: "eos.turn_complete",
      contextId: "turn-x",
      timestampMs: 1200,
      text: "done",
      transcripts: [],
    } satisfies EndOfSpeechPacket);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(scheduler.pendingKeys("interaction.playout:")).toEqual(["interaction.playout:turn-x"]);

    await session.close();
    expect(scheduler.pendingKeys("interaction.playout:")).toEqual([]);
  });

  it("does not initialize an injected policy when full-duplex defer mode owns interaction", async () => {
    const policy = new CapturingInteractionPolicy();
    const session = new VoiceAgentSession({ plugins: {}, interactionPolicy: policy, fullDuplex: true });
    await session.start();
    await closeSession(session);

    expect(policy.initializeCount).toBe(0);
    expect(policy.closeCount).toBe(0);
    expect(policy.observations).toEqual([]);
  });

  it("makes an injected policy the sole endpoint owner while keeping provider STT initialized", async () => {
    const policy = new CapturingInteractionPolicy();
    const provider = new EndpointingPlugin({
      owner: "provider_stt",
      disableConfig: { emit_eos_on_final: false },
    });
    const legacySmartTurn = new EndpointingPlugin({ owner: "smart_turn" });
    const session = new VoiceAgentSession({
      plugins: { stt: { emit_eos_on_final: true }, eos: {} },
      endpointingOwner: "smart_turn",
      interactionPolicy: policy,
    });
    session.registerPlugin("stt", provider);
    session.registerPlugin("eos", legacySmartTurn);
    await session.start();

    expect(provider.initializeCount).toBe(1);
    expect(provider.config).toEqual({ emit_eos_on_final: false });
    expect(legacySmartTurn.initializeCount).toBe(0);
    expect(policy.initializeCount).toBe(1);
    await closeSession(session);
  });

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

  it("G2/WBS-1: surfaces delegate.query/delegate.result packets as delegate_query/delegate_result session events", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const queries: Array<{ turnId: string; query: string; toolName?: string }> = [];
    const results: Array<{ turnId: string; query: string; answer: string; durationMs: number; grounded: boolean }> = [];
    session.on("delegate_query", (event) => queries.push(event));
    session.on("delegate_result", (event) => results.push(event));
    await session.start();

    session.bus.push(Route.Background, {
      kind: "delegate.query",
      contextId: "turn-1",
      timestampMs: Date.now(),
      query: "When is the deadline?",
      toolId: "call_1",
      toolName: "consult_knowledge",
    });
    session.bus.push(Route.Background, {
      kind: "delegate.result",
      contextId: "turn-1",
      timestampMs: Date.now(),
      query: "When is the deadline?",
      answer: "March 31.",
      durationMs: 42,
      grounded: true,
      toolId: "call_1",
      toolName: "consult_knowledge",
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(queries).toEqual([
      { tsMs: expect.any(Number), turnId: "turn-1", query: "When is the deadline?", toolId: "call_1", toolName: "consult_knowledge" },
    ]);
    expect(results).toEqual([
      {
        tsMs: expect.any(Number),
        turnId: "turn-1",
        query: "When is the deadline?",
        answer: "March 31.",
        durationMs: 42,
        grounded: true,
        toolId: "call_1",
        toolName: "consult_knowledge",
      },
    ]);

    await closeSession(session);
  });

  it("surfaces control and blocked delegate metadata through the existing result event", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const results: Array<Record<string, unknown>> = [];
    session.on("delegate_result", (event) => results.push(event));
    await session.start();

    session.bus.push(Route.Background, {
      kind: "delegate.result",
      contextId: "turn-control",
      timestampMs: Date.now(),
      query: "route me",
      answer: "",
      durationMs: 1,
      grounded: false,
      control: { name: "handoff", payload: { targetAgent: "billing" } },
    });
    session.bus.push(Route.Background, {
      kind: "delegate.result",
      contextId: "turn-blocked",
      timestampMs: Date.now(),
      query: "blocked request",
      answer: "I cannot help with that.",
      durationMs: 2,
      grounded: false,
      blocked: { userFacingMessage: "I cannot help with that." },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(results).toEqual([
      expect.objectContaining({
        turnId: "turn-control",
        control: { name: "handoff", payload: { targetAgent: "billing" } },
      }),
      expect.objectContaining({
        turnId: "turn-blocked",
        blocked: { userFacingMessage: "I cannot help with that." },
      }),
    ]);

    await closeSession(session);
  });

  it("emits a decomposed turn_latency session event on first TTS audio", async () => {
    const exporter = new InMemoryMetricsExporter();
    const session = new VoiceAgentSession({
      plugins: {},
      metricsExporter: exporter,
      observability: { sessionId: "session-1", provider: "cascade", model: "model-1", region: "region-1" },
    });
    const events: Array<Record<string, unknown>> = [];
    session.on("turn_latency", (event) => {
      events.push(event);
    });
    await session.start();

    const t0 = 100_000;
    session.bus.push(Route.Main, { kind: "vad.speech_ended", contextId: "turn-1", timestampMs: t0 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    session.bus.push(Route.Main, {
      kind: "eos.turn_complete",
      contextId: "turn-1",
      timestampMs: t0 + 200,
      text: "what are the lab fees",
      transcripts: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    session.bus.push(Route.Main, { kind: "llm.delta", contextId: "turn-1", timestampMs: t0 + 900, text: "The fee is ten dollars." });
    await new Promise((resolve) => setTimeout(resolve, 10));
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "turn-1",
      timestampMs: t0 + 1150,
      audio: new Uint8Array(320),
      sampleRateHz: 16000,
    });
    session.bus.push(Route.Main, {
      kind: "tts.end",
      contextId: "turn-1",
      timestampMs: t0 + 1200,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      tsMs: expect.any(Number),
      turnId: "turn-1",
      ttfaMs: 1150,
      anchor: "speech_end",
      eouDelayMs: 200,
      llmTtftMs: 700,
      textAggregationMs: 0,
      ttsTtfbMs: 250,
      unattributedMs: 0,
      fillerUsed: false,
      backchannelUsed: false,
    });

    expect(exporter.histograms.filter((h) => h.name.startsWith("turn.")).map((h) => [h.name, h.valueMs])).toEqual([
      ["turn.ttfa_ms", 1150],
      ["turn.eou_delay_ms", 200],
      ["turn.llm_ttft_ms", 700],
      ["turn.text_aggregation_ms", 0],
      ["turn.tts_ttfb_ms", 250],
      ["turn.unattributed_ms", 0],
    ]);
    for (const histogram of exporter.histograms.filter((h) => h.name.startsWith("turn."))) {
      expect(histogram.tags).toEqual({
        provider: "cascade",
        model: "model-1",
        region: "region-1",
        cancelled: "false",
        layer: "infrastructure",
        anchor: "speech_end",
        filler_used: "false",
        backchannel_used: "false",
      });
      expect(histogram.tags).not.toHaveProperty("sessionId");
      expect(histogram.tags).not.toHaveProperty("speechId");
    }

    await closeSession(session);
  });

  it("still emits turn_latency when a barge-in interrupts before tts.end", async () => {
    // Emission is deferred to tts.end while generation is active, so later tool passes
    // are counted. That must not make interrupted turns vanish: barge-in correlates with
    // slow turns, so dropping them would bias the metric toward the fast ones — the worst
    // turns disappearing from exactly the number meant to surface them.
    const session = new VoiceAgentSession({ plugins: {} });
    const events: Array<Record<string, unknown>> = [];
    session.on("turn_latency", (event) => {
      events.push(event);
    });
    await session.start();

    const t0 = 600_000;
    const ctx = "barged-turn";
    session.bus.push(Route.Main, { kind: "vad.speech_ended", contextId: ctx, timestampMs: t0 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    session.bus.push(Route.Main, {
      kind: "eos.turn_complete",
      contextId: ctx,
      timestampMs: t0 + 100,
      text: "hello",
      transcripts: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    session.bus.push(Route.Main, { kind: "llm.delta", contextId: ctx, timestampMs: t0 + 300, text: "Hi." });
    await new Promise((resolve) => setTimeout(resolve, 10));
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: ctx,
      timestampMs: t0 + 700,
      audio: new Uint8Array(320),
      sampleRateHz: 16000,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The user barges in — tts.end never arrives for this turn.
    session.bus.push(Route.Critical, {
      kind: "interrupt.detected",
      contextId: ctx,
      timestampMs: t0 + 900,
      source: "vad",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(events).toHaveLength(1);
    expect(events[0]?.["ttfaMs"]).toBe(700); // anchored on first audio, not on the interrupt
    expect(events[0]?.["anchor"]).toBe("speech_end");

    await session.close();
  });

  it("emits turn_latency when the realtime front rotates contextId mid-turn", async () => {
    // Regression: RealtimeBridge.onResponseStarted rotates contextId when the provider starts
    // responding, so the user-side anchor lands on the OLD context while tts.audio lands on the
    // NEW one. Every existing turn_latency test used a single contextId and so never caught this;
    // live native runs emitted nothing at all.
    const session = new VoiceAgentSession({ plugins: {} });
    const events: Array<Record<string, unknown>> = [];
    session.on("turn_latency", (event) => {
      events.push(event);
    });
    await session.start();

    const t0 = 500_000;
    session.bus.push(Route.Main, { kind: "vad.speech_ended", contextId: "ctx-a", timestampMs: t0 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The front begins responding under a brand-new contextId.
    session.bus.push(Route.Main, {
      kind: "turn.change",
      contextId: "ctx-b",
      previousContextId: "ctx-a",
      reason: "realtime_response_started",
      timestampMs: t0 + 200,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    session.bus.push(Route.Main, { kind: "llm.delta", contextId: "ctx-b", timestampMs: t0 + 300, text: "Hi." });
    await new Promise((resolve) => setTimeout(resolve, 10));
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "ctx-b",
      timestampMs: t0 + 600,
      audio: new Uint8Array(320),
      sampleRateHz: 16000,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(events).toHaveLength(1);
    // Anchored on the speech-end recorded under the PREVIOUS context, not silently dropped.
    expect(events[0]?.["anchor"]).toBe("speech_end");
    expect(events[0]?.["ttfaMs"]).toBe(600);

    await session.close();
  });

  it("does not carry prior-context text stages into a new native turn", async () => {
    const exporter = new InMemoryMetricsExporter();
    const session = new VoiceAgentSession({ plugins: {}, metricsExporter: exporter });
    const events: Array<Record<string, unknown>> = [];
    session.on("turn_latency", (event) => {
      events.push(event);
    });
    await session.start();

    const t0 = 600_000;
    session.bus.push(Route.Main, {
      kind: "llm.delta",
      contextId: "idle-prior",
      timestampMs: t0 - 100,
      text: "The previous answer.",
    });
    session.bus.push(Route.Main, {
      kind: "vad.speech_ended",
      contextId: "native-response",
      timestampMs: t0,
    });
    session.bus.push(Route.Main, {
      kind: "turn.change",
      contextId: "native-response",
      previousContextId: "idle-prior",
      reason: "realtime_response_started",
      timestampMs: t0 + 1,
    });
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "native-response",
      timestampMs: t0 + 798,
      audio: new Uint8Array(320),
      sampleRateHz: 16000,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      turnId: "native-response",
      anchor: "speech_end",
      ttfaMs: 798,
      unattributedMs: 798,
    });
    expect(events[0]?.["llmTtftMs"]).toBeUndefined();
    expect(events[0]?.["textAggregationMs"]).toBeUndefined();
    expect(events[0]?.["ttsTtfbMs"]).toBeUndefined();
    expect(exporter.histograms.filter((h) => h.name.startsWith("turn.")).map((h) => h.name)).toEqual([
      "turn.ttfa_ms",
      "turn.unattributed_ms",
    ]);

    await session.close();
  });

  it("emits turn_latency when first audio arrives before eos", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const events: Array<Record<string, unknown>> = [];
    session.on("turn_latency", (event) => {
      events.push(event);
    });
    await session.start();

    const t0 = 400_000;
    session.bus.push(Route.Main, { kind: "vad.speech_ended", contextId: "native-turn", timestampMs: t0 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    session.bus.push(Route.Background, {
      kind: "metric.conversation",
      contextId: "native-turn",
      timestampMs: t0 + 50,
      name: "llm.call_started",
      value: "1",
    });
    session.bus.push(Route.Background, {
      kind: "metric.conversation",
      contextId: "native-turn",
      timestampMs: t0 + 50,
      name: "llm.pass_ttft_ms",
      value: "100",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    session.bus.push(Route.Main, { kind: "llm.delta", contextId: "native-turn", timestampMs: t0 + 100, text: "Hello." });
    await new Promise((resolve) => setTimeout(resolve, 10));
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "native-turn",
      timestampMs: t0 + 400,
      audio: new Uint8Array(320),
      sampleRateHz: 16000,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    session.bus.push(Route.Main, {
      kind: "eos.turn_complete",
      contextId: "native-turn",
      timestampMs: t0 + 1_000,
      text: "hello",
      transcripts: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      turnId: "native-turn",
      ttfaMs: 400,
      anchor: "speech_end",
      llmTtftMs: 100,
      textAggregationMs: 0,
      ttsTtfbMs: 300,
      unattributedMs: 0,
      llmCallCount: 1,
      llmPassTtftMs: [100],
    });

    await closeSession(session);
  });

  it("turn_latency anchors TTFA to eos when no VAD speech-end was seen, and marks filler turns", async () => {
    const session = new VoiceAgentSession({ plugins: {}, latencyFillerEnabled: true });
    const events: Array<Record<string, unknown>> = [];
    session.on("turn_latency", (event) => {
      events.push(event);
    });
    await session.start();

    const t0 = 200_000;
    session.bus.push(Route.Main, {
      kind: "eos.turn_complete",
      contextId: "turn-2",
      timestampMs: t0,
      text: "tell me about registration holds",
      transcripts: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "turn-2",
      timestampMs: t0 + 400,
      audio: new Uint8Array(320),
      sampleRateHz: 16000,
    });
    session.bus.push(Route.Main, {
      kind: "tts.end",
      contextId: "turn-2",
      timestampMs: t0 + 450,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      turnId: "turn-2",
      ttfaMs: 400,
      anchor: "eos",
      fillerUsed: true,
      backchannelUsed: false,
      unattributedMs: 0,
    });
    expect(events[0]!["eouDelayMs"]).toBeUndefined();

    await closeSession(session);
  });

  it("includes provider passes that finish after first audio", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const events: Array<Record<string, unknown>> = [];
    session.on("turn_latency", (event) => {
      events.push(event);
    });
    await session.start();

    const t0 = 700_000;
    session.bus.push(Route.Main, { kind: "vad.speech_ended", contextId: "tool-turn", timestampMs: t0 });
    session.bus.push(Route.Main, {
      kind: "eos.turn_complete",
      contextId: "tool-turn",
      timestampMs: t0 + 200,
      text: "check the fee",
      transcripts: [],
    });
    session.bus.push(Route.Main, {
      kind: "metric.conversation",
      contextId: "tool-turn",
      timestampMs: t0 + 200,
      name: "llm.call_started",
      value: "1",
    });
    session.bus.push(Route.Main, {
      kind: "metric.conversation",
      contextId: "tool-turn",
      timestampMs: t0 + 300,
      name: "llm.pass_ttft_ms",
      value: "100",
    });
    session.bus.push(Route.Main, {
      kind: "llm.delta",
      contextId: "tool-turn",
      timestampMs: t0 + 300,
      text: "Let me check.",
    });
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "tool-turn",
      timestampMs: t0 + 400,
      audio: new Uint8Array(320),
      sampleRateHz: 16000,
    });
    session.bus.push(Route.Main, {
      kind: "metric.conversation",
      contextId: "tool-turn",
      timestampMs: t0 + 600,
      name: "llm.call_started",
      value: "1",
    });
    session.bus.push(Route.Main, {
      kind: "metric.conversation",
      contextId: "tool-turn",
      timestampMs: t0 + 800,
      name: "llm.pass_ttft_ms",
      value: "200",
    });
    session.bus.push(Route.Main, {
      kind: "llm.done",
      contextId: "tool-turn",
      timestampMs: t0 + 900,
      text: "Let me check. The fee is ten dollars.",
    });
    session.bus.push(Route.Main, {
      kind: "tts.end",
      contextId: "tool-turn",
      timestampMs: t0 + 950,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      turnId: "tool-turn",
      ttfaMs: 400,
      eouDelayMs: 200,
      llmTtftMs: 100,
      textAggregationMs: 0,
      ttsTtfbMs: 100,
      unattributedMs: 0,
      llmCallCount: 2,
      llmPassTtftMs: [100, 200],
    });

    await session.close();
  });

  it("does not emit turn_latency for audio without a voice or endpoint anchor", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const events: unknown[] = [];
    session.on("turn_latency", (event) => { events.push(event); });
    await session.start();

    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "text-only",
      timestampMs: 500_400,
      audio: new Uint8Array(320),
      sampleRateHz: 16000,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(events).toEqual([]);
    await closeSession(session);
  });

  it("turn_latency is not emitted for an interrupted turn", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const events: unknown[] = [];
    session.on("turn_latency", (event) => {
      events.push(event);
    });
    await session.start();

    const t0 = 300_000;
    session.bus.push(Route.Main, {
      kind: "eos.turn_complete",
      contextId: "turn-3",
      timestampMs: t0,
      text: "hello there",
      transcripts: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    session.bus.push(Route.Critical, {
      kind: "interrupt.detected",
      contextId: "turn-3",
      timestampMs: t0 + 100,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "turn-3",
      timestampMs: t0 + 300,
      audio: new Uint8Array(320),
      sampleRateHz: 16000,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(events).toHaveLength(0);

    await closeSession(session);
  });

  it("IP-C3: tool_call_cue.delayed emits interaction.backchannel end-to-end", async () => {
    const session = new VoiceAgentSession({ plugins: {}, delayCueAfterMs: 30 });
    const backchannels: InteractionBackchannelPacket[] = [];
    session.bus.on("interaction.backchannel", (pkt) => {
      backchannels.push(pkt as InteractionBackchannelPacket);
    });
    await session.start();

    session.bus.push(Route.Main, {
      kind: "llm.tool_call",
      contextId: "turn-1",
      timestampMs: Date.now(),
      toolId: "t1",
      toolName: "consult_knowledge",
      toolArgs: { query: "fees" },
    });

    await new Promise((resolve) => setTimeout(resolve, 70));

    expect(backchannels).toHaveLength(1);
    expect(backchannels[0]).toMatchObject({ contextId: "turn-1", cue: "mm_hmm" });

    await closeSession(session);
  });

  it("G3/WBS-3: tool-call lifecycle cues fire started → delayed → complete", async () => {
    const session = new VoiceAgentSession({ plugins: {}, delayCueAfterMs: 30 });
    const cues: Array<{ phase: string; turnId: string; toolId: string; toolName: string; afterMs?: number }> = [];
    session.on("tool_call_cue", (event) => cues.push(event));
    await session.start();

    session.bus.push(Route.Main, {
      kind: "llm.tool_call",
      contextId: "turn-1",
      timestampMs: Date.now(),
      toolId: "t1",
      toolName: "consult_knowledge",
      toolArgs: { query: "fees" },
    });

    await new Promise((resolve) => setTimeout(resolve, 70));

    session.bus.push(Route.Main, {
      kind: "llm.tool_result",
      contextId: "turn-1",
      timestampMs: Date.now(),
      toolId: "t1",
      toolName: "consult_knowledge",
      result: "answer",
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(cues.map((cue) => cue.phase)).toEqual(["started", "delayed", "complete"]);
    expect(cues[0]).toMatchObject({ turnId: "turn-1", toolId: "t1", toolName: "consult_knowledge" });
    expect(cues[1]!.afterMs).toBe(30);

    await closeSession(session);
  });

  it("G3/WBS-3: no delayed cue when the result beats the timer; timer 0 disables it", async () => {
    const session = new VoiceAgentSession({ plugins: {}, delayCueAfterMs: 5000 });
    const cues: Array<{ phase: string }> = [];
    session.on("tool_call_cue", (event) => cues.push(event));
    await session.start();

    session.bus.push(Route.Main, {
      kind: "llm.tool_call",
      contextId: "turn-1",
      timestampMs: Date.now(),
      toolId: "t1",
      toolName: "consult_knowledge",
      toolArgs: {},
    });
    session.bus.push(Route.Main, {
      kind: "llm.tool_result",
      contextId: "turn-1",
      timestampMs: Date.now(),
      toolId: "t1",
      toolName: "consult_knowledge",
      result: "fast answer",
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(cues.map((cue) => cue.phase)).toEqual(["started", "complete"]);

    await closeSession(session);

    const disabled = new VoiceAgentSession({ plugins: {}, delayCueAfterMs: 0 });
    const disabledCues: Array<{ phase: string }> = [];
    disabled.on("tool_call_cue", (event) => disabledCues.push(event));
    await disabled.start();
    disabled.bus.push(Route.Main, {
      kind: "llm.tool_call",
      contextId: "turn-2",
      timestampMs: Date.now(),
      toolId: "t2",
      toolName: "consult_knowledge",
      toolArgs: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(disabledCues.map((cue) => cue.phase)).toEqual(["started"]);
    await closeSession(disabled);
  });

  it("G3/WBS-3: llm.error while a tool call is pending fires the failed cue", async () => {
    const session = new VoiceAgentSession({ plugins: {}, delayCueAfterMs: 0 });
    const cues: Array<{ phase: string; toolId: string }> = [];
    session.on("tool_call_cue", (event) => cues.push(event));
    await session.start();

    session.bus.push(Route.Main, {
      kind: "llm.tool_call",
      contextId: "turn-1",
      timestampMs: Date.now(),
      toolId: "t1",
      toolName: "consult_knowledge",
      toolArgs: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 10)); // let Main drain before the Critical error
    session.bus.push(Route.Critical, {
      kind: "llm.error",
      contextId: "turn-1",
      timestampMs: Date.now(),
      component: "bridge",
      category: ErrorCategory.NetworkTimeout,
      cause: new Error("delegate failed"),
      isRecoverable: true,
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(cues.map((cue) => cue.phase)).toEqual(["started", "failed"]);
    expect(cues[1]!.toolId).toBe("t1");

    await closeSession(session);
  });

  it("G3/WBS-3 (R5): barge-in fails the pending cue and the interrupt path is unaffected", async () => {
    const session = new VoiceAgentSession({ plugins: {}, delayCueAfterMs: 5000, minInterruptionMs: 0 });
    const cues: Array<{ phase: string }> = [];
    const interrupts: string[] = [];
    session.on("tool_call_cue", (event) => cues.push(event));
    session.bus.on("interrupt.tts", (pkt) => { interrupts.push((pkt as { contextId: string }).contextId); });
    await session.start();

    session.bus.push(Route.Main, {
      kind: "llm.tool_call",
      contextId: "turn-1",
      timestampMs: Date.now(),
      toolId: "t1",
      toolName: "consult_knowledge",
      toolArgs: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 10)); // let Main drain before the Critical interrupt
    session.bus.push(Route.Critical, {
      kind: "interrupt.detected",
      contextId: "turn-1",
      timestampMs: Date.now(),
      source: "client",
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(cues.map((cue) => cue.phase)).toEqual(["started", "failed"]);
    expect(interrupts).toContain("turn-1"); // barge-in cancel still flowed

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

  it("durationMs:0 disables the idle timeout, including the extend/playout path", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const session = new VoiceAgentSession({
      plugins: {},
      idleTimeout: {
        durationMs: 0,
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

      // tts.audio drives extend(playoutMs); with durationMs:0 it must arm nothing.
      session.bus.push(Route.Main, {
        kind: "tts.audio",
        contextId: "turn-1",
        timestampMs: Date.now(),
        audio: new Uint8Array(3200),
        sampleRateHz: 16000,
      } satisfies TextToSpeechAudioPacket);
      await vi.advanceTimersByTimeAsync(0);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(injected).toEqual([]);
    } finally {
      vi.useRealTimers();
      await closeSession(session);
    }
  });

  it("routes context injections to the bridge without creating spoken LLM output", async () => {
    const bridge = new ContextCapturingBridgePlugin();
    const session = new VoiceAgentSession({ plugins: { bridge: {} } });
    session.registerPlugin("bridge", bridge);
    const deltas: LlmDeltaPacket[] = [];
    const ttsText: TextToSpeechTextPacket[] = [];
    session.bus.on("llm.delta", (pkt) => {
      deltas.push(pkt as LlmDeltaPacket);
    });
    session.bus.on("tts.text", (pkt) => {
      ttsText.push(pkt as TextToSpeechTextPacket);
    });

    await session.start();
    session.bus.push(Route.Main, {
      kind: "inject.message",
      contextId: "observer-turn",
      timestampMs: Date.now(),
      text: "Use the verified deadline.",
      mode: "context",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(bridge.injectedContext).toEqual(["Use the verified deadline."]);
    expect(deltas).toEqual([]);
    expect(ttsText).toEqual([]);

    await closeSession(session);
  });

  it("keeps omitted or speak injections on the synthetic TTS path and starts idle timeout", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const deltas: LlmDeltaPacket[] = [];
    const dones: LlmResponseDonePacket[] = [];
    const idleStarts: string[] = [];
    session.bus.on("llm.delta", (pkt) => {
      deltas.push(pkt as LlmDeltaPacket);
    });
    session.bus.on("llm.done", (pkt) => {
      dones.push(pkt as LlmResponseDonePacket);
    });
    session.bus.on("behavior.idle_timeout_start", (pkt) => {
      idleStarts.push((pkt as { contextId: string }).contextId);
    });

    await session.start();
    session.bus.push(Route.Main, {
      kind: "inject.message",
      contextId: "spoken-injection",
      timestampMs: Date.now(),
      text: "Please say this.",
      mode: "speak",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(deltas).toEqual([expect.objectContaining({ text: "Please say this." })]);
    expect(dones).toEqual([expect.objectContaining({ text: "Please say this." })]);
    expect(idleStarts).toContain("spoken-injection");

    await closeSession(session);
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

  it("fullDuplex:true runs the interaction policy observe-only (no VAD-driven interrupt)", async () => {
    const session = new VoiceAgentSession({ plugins: {}, minInterruptionMs: 280, fullDuplex: true });
    const interrupts: InterruptTtsPacket[] = [];

    await session.start();
    session.bus.on("interrupt.tts", (pkt) => {
      interrupts.push(pkt as InterruptTtsPacket);
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
      timestampMs: t0 + 100,
      isAsync: true,
    } satisfies VadSpeechActivityPacket);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(interrupts).toEqual([]);

    session.bus.push(Route.Main, {
      kind: "vad.speech_activity",
      contextId: "user",
      timestampMs: t0 + 300,
      isAsync: true,
    } satisfies VadSpeechActivityPacket);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(interrupts).toEqual([]);

    await closeSession(session);
  });

  it("fullDuplex:true still honors a direct client interrupt (executor survives defer mode) (IP-C2 regression)", async () => {
    // Defer mode swaps only the coordinator's DRIVE policy to observe-only; the executor stays the
    // rule policy's arbiter, so a client-initiated "stop" (requestClientInterrupt) must still fire —
    // the front owning turn-taking does not disable the user's explicit interrupt.
    const session = new VoiceAgentSession({ plugins: {}, minInterruptionMs: 280, fullDuplex: true });
    const interrupts: InterruptTtsPacket[] = [];

    await session.start();
    session.bus.on("interrupt.tts", (pkt) => {
      interrupts.push(pkt as InterruptTtsPacket);
    });

    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "assistant-turn",
      timestampMs: Date.now(),
      audio: new Uint8Array([1, 2, 3, 4]),
      sampleRateHz: 16000,
    } satisfies TextToSpeechAudioPacket);
    await new Promise((resolve) => setTimeout(resolve, 10));

    session.requestClientInterrupt("assistant-turn");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(interrupts).toEqual([
      expect.objectContaining({ kind: "interrupt.tts", contextId: "assistant-turn" }),
    ]);

    await closeSession(session);
  });

  it("stt.partial carries wordTimings but does NOT itself drive barge-in (IP-C4 no-double-drive guard)", async () => {
    // IP-C4: stt.partial is the rich-seam carrier; the session caches its wordTimings for the
    // observation but barge-in stays driven ONLY by stt.interim/stt.result. Pushing sustained
    // stt.partial (no interim) during active TTS must NOT interrupt — proving no second barge-in driver.
    const session = new VoiceAgentSession({ plugins: {}, minInterruptionMs: 280 });
    const interrupts: InterruptTtsPacket[] = [];

    await session.start();
    session.bus.on("interrupt.tts", (pkt) => {
      interrupts.push(pkt as InterruptTtsPacket);
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
      kind: "stt.partial",
      contextId: "user",
      timestampMs: t0,
      text: "wait actually I need",
      wordTimings: [{ word: "wait", startMs: 0, endMs: 200, confidence: 0.9 }],
    } satisfies SttPartialPacket);
    session.bus.push(Route.Main, {
      kind: "stt.partial",
      contextId: "user",
      timestampMs: t0 + 400,
      text: "wait actually I need something else",
      wordTimings: [{ word: "wait", startMs: 0, endMs: 200, confidence: 0.9 }],
    } satisfies SttPartialPacket);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(interrupts).toEqual([]);

    await closeSession(session);
  });

  it("commits a barge-in from provider STT interim transcripts when no VAD plugin is registered", async () => {
    // Cascade deployments with endpointingOwner "provider_stt" (the default) have
    // no vad.speech_started producer — interim transcripts during TTS playout are
    // the barge-in evidence.
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
      kind: "stt.interim",
      contextId: "user",
      timestampMs: t0,
      text: "wait actually",
    } satisfies SttInterimPacket);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(interrupts).toEqual([]);

    session.bus.push(Route.Main, {
      kind: "stt.interim",
      contextId: "user",
      timestampMs: t0 + 300,
      text: "wait actually I need something else",
    } satisfies SttInterimPacket);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(interrupts).toEqual([
      expect.objectContaining({ kind: "interrupt.tts", contextId: "assistant-turn" }),
    ]);
    expect(metrics).toContain("interrupt.committed_after_ms");

    await closeSession(session);
  });

  it("attaches cached stt.partial wordTimings to the next barge-in observation (IP-C4)", async () => {
    const session = new VoiceAgentSession({ plugins: {}, minInterruptionMs: 280 });
    const observations: InteractionObservation[] = [];
    await session.start();

    const interaction = (session as unknown as { interaction: InteractionCoordinator }).interaction;
    const originalObserve = interaction.observe.bind(interaction);
    interaction.observe = (obs) => {
      observations.push(obs);
      originalObserve(obs);
    };

    session.bus.push(Route.Main, {
      kind: "stt.partial",
      contextId: "user",
      timestampMs: Date.now(),
      text: "wait actually",
      wordTimings: [{ word: "wait", startMs: 100, endMs: 300, confidence: 0.9 }],
    } satisfies SttPartialPacket);

    session.bus.push(Route.Main, {
      kind: "stt.interim",
      contextId: "user",
      timestampMs: Date.now(),
      text: "wait actually",
    } satisfies SttInterimPacket);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "stt_partial",
          text: "wait actually",
          wordTimings: [{ word: "wait", startMs: 100, endMs: 300, confidence: 0.9 }],
        }),
      ]),
    );

    await closeSession(session);
  });

  it("suppresses a backchannel provider-STT interim through the interaction seam (IP-C1 regression)", async () => {
    // IP-C1 routed provider-STT barge-in through InteractionCoordinator ->
    // RuleBasedInteractionPolicy -> TurnArbiter. This pins that the reshaped
    // chain still SUPPRESSES a sustained backchannel ("okay") rather than cutting
    // the assistant — the session-level suppression case the policy-unit test
    // (rule-based.test.ts, vad-driven) and the commit test above do not cover.
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

    // Sustained-past-minInterruptionMs backchannel evidence: opens the pending
    // window, then the second interim (past 280ms) reaches tryCommit -> the
    // arbiter's backchannel suppression fires instead of an interrupt decision.
    const t0 = Date.now();
    session.bus.push(Route.Main, {
      kind: "stt.interim",
      contextId: "user",
      timestampMs: t0,
      text: "okay",
    } satisfies SttInterimPacket);
    await new Promise((resolve) => setTimeout(resolve, 20));
    session.bus.push(Route.Main, {
      kind: "stt.interim",
      contextId: "user",
      timestampMs: t0 + 300,
      text: "okay",
    } satisfies SttInterimPacket);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(interrupts).toEqual([]);
    expect(metrics).toContain("interrupt.suppressed_backchannel");

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

describe("VoiceAgentSession.prewarm", () => {
  it("calls each plugin prewarm exactly once", async () => {
    const prewarm = vi.fn(async () => {});
    const plugin: VoicePlugin = {
      async initialize() {},
      async close() {},
      prewarm,
    };
    const session = new VoiceAgentSession({ plugins: { tts: {} } });
    session.registerPlugin("tts", plugin);
    await session.start();
    await session.prewarm();
    expect(prewarm).toHaveBeenCalledTimes(1);
    await closeSession(session);
  });

  it("skips plugins without prewarm", async () => {
    const plugin: VoicePlugin = {
      async initialize() {},
      async close() {},
    };
    const session = new VoiceAgentSession({ plugins: { tts: {} } });
    session.registerPlugin("tts", plugin);
    await session.start();
    await expect(session.prewarm()).resolves.toBeUndefined();
    await closeSession(session);
  });

  it("does not throw when a plugin prewarm rejects", async () => {
    const plugin: VoicePlugin = {
      async initialize() {},
      async close() {},
      prewarm: async () => {
        throw new Error("warm failed");
      },
    };
    const session = new VoiceAgentSession({ plugins: { tts: {} } });
    session.registerPlugin("tts", plugin);
    await session.start();
    await expect(session.prewarm()).resolves.toBeUndefined();
    await closeSession(session);
  });
});

describe("VoiceAgentSession — handler errors must not kill the call", () => {
  it("a throwing bus handler surfaces a recoverable pipeline.error and the session stays alive", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const errors: Array<{ stage: string }> = [];
    const partials: Array<{ text: string }> = [];
    await session.start();
    session.on("error", (event) => {
      errors.push(event);
    });
    session.on("user_input_partial", (event) => {
      partials.push(event);
    });
    session.bus.on("tts.text", () => {
      throw new Error("plugin bug: scripted batches missing");
    });

    session.bus.push(Route.Main, {
      kind: "tts.text",
      contextId: "turn-boom",
      timestampMs: Date.now(),
      text: "speak this",
    } satisfies TextToSpeechTextPacket);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(errors).toEqual([
      expect.objectContaining({ stage: "pipeline.error" }),
    ]);

    // The call must continue: later packets still flow end to end.
    session.bus.push(Route.Main, {
      kind: "stt.interim",
      contextId: "turn-after",
      timestampMs: Date.now(),
      text: "still alive",
    } satisfies SttInterimPacket);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(partials).toEqual([
      expect.objectContaining({ text: "still alive" }),
    ]);

    await closeSession(session);
  });
});

describe("VoiceAgentSession supersede + thinking-phase barge-in", () => {
  it("cancels a still-playing prior turn's TTS when a new turn completes (L1)", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const interruptTts: InterruptTtsPacket[] = [];
    await session.start();
    session.bus.on("interrupt.tts", (pkt) => { interruptTts.push(pkt as InterruptTtsPacket); });

    // Turn 1 is generating + has streamed audio (still playing out).
    session.bus.push(Route.Main, {
      kind: "eos.turn_complete", contextId: "turn-1", timestampMs: Date.now(), text: "one", transcripts: [],
    } satisfies EndOfSpeechPacket);
    await new Promise((r) => setTimeout(r, 5));
    session.bus.push(Route.Main, {
      kind: "tts.audio", contextId: "turn-1", timestampMs: Date.now(),
      audio: new Uint8Array(16000), sampleRateHz: 16000, // ~0.5s of audio still playing
    } satisfies TextToSpeechAudioPacket);
    await new Promise((r) => setTimeout(r, 5));

    // Turn 2 completes while turn 1 is still playing → turn 1 must be cancelled.
    session.bus.push(Route.Main, {
      kind: "eos.turn_complete", contextId: "turn-2", timestampMs: Date.now(), text: "two", transcripts: [],
    } satisfies EndOfSpeechPacket);
    await new Promise((r) => setTimeout(r, 10));

    expect(interruptTts.some((p) => p.contextId === "turn-1")).toBe(true);
    expect(interruptTts.some((p) => p.contextId === "turn-2")).toBe(false);

    await closeSession(session);
  });

  it("honors a client interrupt during the reasoner TTFT gap, before any audio (B3)", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const interruptLlm: InterruptLlmPacket[] = [];
    await session.start();
    session.bus.on("interrupt.llm", (pkt) => { interruptLlm.push(pkt as InterruptLlmPacket); });

    // Turn completes; generation is in-flight but NO tts.audio has played yet.
    session.bus.push(Route.Main, {
      kind: "eos.turn_complete", contextId: "turn-think", timestampMs: Date.now(), text: "q", transcripts: [],
    } satisfies EndOfSpeechPacket);
    await new Promise((r) => setTimeout(r, 5));

    session.requestClientInterrupt("turn-think");
    await new Promise((r) => setTimeout(r, 10));

    expect(interruptLlm.some((p) => p.contextId === "turn-think")).toBe(true);

    await closeSession(session);
  });

  it("drops a backchannel during the assistant's turn: no cancel, no second response (B4)", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const interruptTts: InterruptTtsPacket[] = [];
    const userInputs: UserInputPacket[] = [];
    await session.start();
    session.bus.on("interrupt.tts", (pkt) => { interruptTts.push(pkt as InterruptTtsPacket); });
    session.bus.on("user.input", (pkt) => { userInputs.push(pkt as UserInputPacket); });

    // Assistant is speaking turn-1 (audio actively playing out).
    session.bus.push(Route.Main, {
      kind: "eos.turn_complete", contextId: "turn-1", timestampMs: Date.now(), text: "here is the answer", transcripts: [],
    } satisfies EndOfSpeechPacket);
    await new Promise((r) => setTimeout(r, 5));
    session.bus.push(Route.Main, {
      kind: "tts.audio", contextId: "turn-1", timestampMs: Date.now(), audio: new Uint8Array(16000), sampleRateHz: 16000,
    } satisfies TextToSpeechAudioPacket);
    await new Promise((r) => setTimeout(r, 5));

    // User says "uh-huh" (a rotated context) mid-answer — a backchannel, not a turn.
    session.bus.push(Route.Main, {
      kind: "eos.turn_complete", contextId: "turn-2", timestampMs: Date.now(), text: "uh-huh", transcripts: [],
    } satisfies EndOfSpeechPacket);
    await new Promise((r) => setTimeout(r, 10));

    // The assistant's turn is NOT cancelled and the backchannel does NOT drive the LLM.
    expect(interruptTts.some((p) => p.contextId === "turn-1")).toBe(false);
    expect(userInputs.some((p) => p.contextId === "turn-2")).toBe(false);

    await closeSession(session);
  });
});

describe("VoiceAgentSession observability seams", () => {
  it("localizes infrastructure, conversation, and clean turns independently", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const localizations: TurnLocalizationPacket[] = [];
    session.bus.on("turn.localization", (pkt) => { localizations.push(pkt as TurnLocalizationPacket); });
    await session.start();

    session.bus.push(Route.Main, {
      kind: "vad.speech_ended",
      contextId: "infra-turn",
      timestampMs: 0,
    } satisfies VadSpeechEndedPacket);
    session.bus.push(Route.Main, {
      kind: "eos.turn_complete",
      contextId: "infra-turn",
      timestampMs: 0,
      text: "hello",
      transcripts: [],
    } satisfies EndOfSpeechPacket);
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "infra-turn",
      timestampMs: 1000,
      audio: new Uint8Array([1, 2]),
      sampleRateHz: 16000,
    } satisfies TextToSpeechAudioPacket);
    session.bus.push(Route.Main, {
      kind: "tts.end",
      contextId: "infra-turn",
      timestampMs: 1001,
    } satisfies TextToSpeechEndPacket);

    session.bus.push(Route.Background, {
      kind: "metric.conversation",
      contextId: "conversation-turn",
      timestampMs: 2,
      name: "outcome.failed",
      value: "task_failure",
    });
    session.bus.push(Route.Main, {
      kind: "tts.end",
      contextId: "conversation-turn",
      timestampMs: 3,
    } satisfies TextToSpeechEndPacket);
    session.bus.push(Route.Main, {
      kind: "tts.end",
      contextId: "clean-turn",
      timestampMs: 4,
    } satisfies TextToSpeechEndPacket);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(localizations.map((event) => [event.contextId, event.value])).toEqual([
      ["infra-turn", "infrastructure"],
      ["conversation-turn", "conversation"],
      ["clean-turn", "none"],
    ]);
    expect(localizations.find((event) => event.contextId === "conversation-turn")).toMatchObject({
      infrastructureBreached: false,
      conversationFlagged: true,
    });

    await closeSession(session);
  });

  it("emits distinct backchannel and interruption acoustic signals with conversation tags", async () => {
    const exporter = new InMemoryMetricsExporter();
    const session = new VoiceAgentSession({ plugins: {}, metricsExporter: exporter });
    const signals: AcousticSignalPacket[] = [];
    session.bus.on("acoustic.signal", (pkt) => { signals.push(pkt as AcousticSignalPacket); });
    await session.start();

    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "assistant-turn",
      timestampMs: 1,
      audio: new Uint8Array(16000),
      sampleRateHz: 16000,
    } satisfies TextToSpeechAudioPacket);
    await new Promise((resolve) => setTimeout(resolve, 5));
    session.bus.push(Route.Main, {
      kind: "eos.turn_complete",
      contextId: "backchannel-turn",
      timestampMs: 2,
      text: "yeah",
      transcripts: [],
    } satisfies EndOfSpeechPacket);
    await new Promise((resolve) => setTimeout(resolve, 5));
    session.bus.push(Route.Critical, {
      kind: "interrupt.detected",
      contextId: "assistant-turn",
      timestampMs: 3,
      source: "vad",
    } satisfies InterruptionDetectedPacket);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(signals.map((signal) => signal.signal)).toEqual(["backchannel", "interruption"]);
    expect(exporter.counters.filter((counter) => counter.name.startsWith("acoustic.")).map((counter) => counter.name)).toEqual([
      "acoustic.backchannel",
      "acoustic.interruption",
    ]);
    for (const counter of exporter.counters.filter((entry) => entry.name.startsWith("acoustic."))) {
      expect(counter.tags).toMatchObject({ layer: "conversation" });
      expect(counter.tags).not.toHaveProperty("contextId");
    }

    await closeSession(session);
  });
});

describe("VoiceAgentSession usage metering", () => {
  it("accumulates usage.recorded across turns and emits a session.usage manifest at close", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const manifests: Array<{ stages: readonly SessionStageUsage[] }> = [];
    session.on("usage", (e) => manifests.push(e));
    await session.start();

    // Two LLM turns' worth of usage — the accumulator must SUM them, not overwrite.
    session.bus.push(Route.Background, {
      kind: "usage.recorded", contextId: "t1", timestampMs: Date.now(),
      stage: "llm", inputTokens: 100, outputTokens: 40, totalTokens: 140,
    });
    session.bus.push(Route.Background, {
      kind: "usage.recorded", contextId: "t2", timestampMs: Date.now(),
      stage: "llm", inputTokens: 60, outputTokens: 20, totalTokens: 80,
    });
    await new Promise((r) => setTimeout(r, 10));

    await closeSession(session);

    expect(manifests).toHaveLength(1);
    const llm = manifests[0]?.stages.find((s) => s.stage === "llm");
    expect(llm).toEqual({ stage: "llm", inputTokens: 160, outputTokens: 60, totalTokens: 220 });
  });

  it("exports usage as counters with only low-cardinality tags (never contextId)", async () => {
    const exporter = new InMemoryMetricsExporter();
    const session = new VoiceAgentSession({ plugins: {}, metricsExporter: exporter });
    await session.start();

    session.bus.push(Route.Background, {
      kind: "usage.recorded", contextId: "secret-session-42", timestampMs: Date.now(),
      stage: "llm", provider: "openai", model: "gpt-4.1-mini", inputTokens: 10, outputTokens: 5, totalTokens: 15,
    });
    await new Promise((r) => setTimeout(r, 10));
    await closeSession(session);

    const usageCounters = exporter.counters.filter((c) => c.name.startsWith("usage."));
    expect(usageCounters.length).toBeGreaterThan(0);
    for (const c of usageCounters) {
      expect(c.tags).toEqual({
        stage: "llm",
        provider: "openai",
        model: "gpt-4.1-mini",
        layer: "infrastructure",
      });
      expect(c.tags).not.toHaveProperty("contextId");
      expect(Object.values(c.tags)).not.toContain("secret-session-42");
    }
    // The actual counts made it through.
    expect(usageCounters.find((c) => c.name === "usage.totalTokens")?.value).toBe(15);
  });

  it("strips markdown from LLM text before it reaches tts.text (wiring, not just the fn)", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const spoken: string[] = [];
    session.bus.on("tts.text", (pkt) => {
      spoken.push((pkt as unknown as { text: string }).text);
    });
    await session.start();

    // A complete sentence full of markdown — must be spoken clean, not read literally.
    session.bus.push(Route.Main, {
      kind: "llm.delta",
      contextId: "md-turn",
      timestampMs: Date.now(),
      text: "Your **late add** deadline is on the [portal](https://x.edu).",
    });
    await new Promise((r) => setTimeout(r, 10));
    await closeSession(session);

    expect(spoken.join(" ")).toContain("Your late add deadline is on the portal.");
    expect(spoken.join(" ")).not.toContain("**");
    expect(spoken.join(" ")).not.toContain("](http");
  });

  it("emits no usage manifest when no usage was recorded", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const manifests: unknown[] = [];
    session.on("usage", (e) => manifests.push(e));
    await session.start();
    await closeSession(session);
    expect(manifests).toHaveLength(0);
  });
});
