// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it } from "vitest";

import {
  PipelineBusImpl,
  Route,
  VoiceAgentSession,
  type DelegateQueryPacket,
  type DelegateResultPacket,
  type EndOfSpeechPacket,
  type InterruptTtsPacket,
  type InterruptionDetectedPacket,
  type LlmDeltaPacket,
  type LlmResponseDonePacket,
  type LlmErrorPacket,
  type LlmToolResultPacket,
  type Reasoner,
  type ReasonerMessage,
  type RecordAssistantAudioPacket,
  type SttResultPacket,
  type TextToSpeechAudioPacket,
  type TextToSpeechEndPacket,
  type TurnChangePacket,
  type UsageRecordedPacket,
  type VoicePacket,
} from "@kuralle-syrinx/core";

import type { RealtimeAdapter, RealtimeEvent } from "./realtime-adapter.js";
import { RealtimeBridge } from "./realtime-bridge.js";

class FakeRealtimeAdapter implements RealtimeAdapter {
  readonly caps: RealtimeAdapter["caps"];

  constructor(caps?: Partial<RealtimeAdapter["caps"]>) {
    this.caps = {
      inputSampleRateHz: 24_000,
      outputSampleRateHz: 24_000,
      supportsConcurrentToolAudio: true,
      supportsTruncate: true,
      emitsServerSpeechStarted: true,
      ...caps,
    };
  }

  private readonly queued: RealtimeEvent[] = [];
  private readonly waiters: Array<(event: RealtimeEvent | null) => void> = [];
  private closed = false;
  readonly sentAudio: Uint8Array[] = [];

  readonly events: AsyncIterable<RealtimeEvent> = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<RealtimeEvent>> => {
        if (this.queued.length > 0) {
          return { value: this.queued.shift()!, done: false };
        }
        if (this.closed) return { value: undefined, done: true };
        const event = await new Promise<RealtimeEvent | null>((resolve) => {
          this.waiters.push(resolve);
        });
        if (event === null) return { value: undefined, done: true };
        return { value: event, done: false };
      },
    }),
  };

  async open(_signal: AbortSignal): Promise<void> {}

  sendAudio(pcm16: Uint8Array): void {
    this.sentAudio.push(pcm16);
  }

  readonly sentText: string[] = [];
  readonly injectedContexts: string[] = [];

  sendText(text: string): void {
    this.sentText.push(text);
  }

  injectContext(text: string): void {
    this.injectedContexts.push(text);
  }

  requestResponseCalls = 0;

  requestResponse(): void {
    this.requestResponseCalls += 1;
  }

  readonly cancelCalls: number[] = [];

  cancelResponse(audioEndMs: number): void {
    this.cancelCalls.push(audioEndMs);
  }

  readonly injectedToolResults: Array<{ toolId: string; text: string }> = [];

  injectToolResult(toolId: string, text: string): void {
    this.injectedToolResults.push({ toolId, text });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const resolve of this.waiters.splice(0)) resolve(null);
  }

  emit(event: RealtimeEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(event);
    else this.queued.push(event);
  }

}

function pcmFromSamples(samples: readonly number[]): Uint8Array {
  const pcm = Int16Array.from(samples);
  return new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}

function frameSizedPcm24k(): Uint8Array {
  return pcmFromSamples(Array.from({ length: 960 }, (_, i) => i));
}

function frameDurationMs(frame: TextToSpeechAudioPacket): number {
  return (frame.audio.byteLength / 2 / frame.sampleRateHz) * 1000;
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

describe("RealtimeBridge", () => {
  const buses: PipelineBusImpl[] = [];

  afterEach(() => {
    for (const bus of buses.splice(0)) bus.stop();
  });

  it("forwards silent context to the adapter without creating a response", async () => {
    const adapter = new FakeRealtimeAdapter();
    const bridge = new RealtimeBridge(adapter);

    bridge.injectContext("Correction: use the verified deadline.");

    expect(adapter.injectedContexts).toEqual(["Correction: use the verified deadline."]);
    expect(adapter.requestResponseCalls).toBe(0);
  });

  it("maps one turn to turn.change → tts.audio → eos.turn_complete → tts.end with one contextId", async () => {
    const adapter = new FakeRealtimeAdapter();
    const bridge = new RealtimeBridge(adapter);
    const bus = new PipelineBusImpl();
    buses.push(bus);
    const packets: VoicePacket[] = [];
    bus.on("turn.change", (pkt) => { packets.push(pkt as TurnChangePacket); });
    bus.on("tts.audio", (pkt) => { packets.push(pkt as TextToSpeechAudioPacket); });
    bus.on("eos.turn_complete", (pkt) => { packets.push(pkt as EndOfSpeechPacket); });
    bus.on("tts.end", (pkt) => { packets.push(pkt as TextToSpeechEndPacket); });
    bus.on("stt.result", (pkt) => { packets.push(pkt as SttResultPacket); });

    const started = bus.start();
    await bridge.initialize(bus, {});

    bus.push(Route.Media, {
      kind: "user.audio_received",
      contextId: "transport-turn",
      timestampMs: Date.now(),
      audio: pcmFromSamples([100, 200, 300, 400]),
    });

    adapter.emit({ type: "response_started" });
    adapter.emit({
      type: "audio",
      pcm16: pcmFromSamples(Array.from({ length: 960 }, (_, i) => i)),
      sampleRateHz: 24_000,
    });
    adapter.emit({ type: "transcript", role: "user", text: "hello there", final: true });
    adapter.emit({ type: "response_done" });

    await waitForCondition(() => packets.some((p) => p.kind === "tts.end"));

    const turnChanges = packets.filter((p): p is TurnChangePacket => p.kind === "turn.change");
    const audio = packets.filter((p): p is TextToSpeechAudioPacket => p.kind === "tts.audio");
    const turnComplete = packets.filter((p): p is EndOfSpeechPacket => p.kind === "eos.turn_complete");
    const ends = packets.filter((p): p is TextToSpeechEndPacket => p.kind === "tts.end");

    expect(turnChanges).toHaveLength(1);
    expect(audio.length).toBeGreaterThan(0);
    expect(turnComplete).toHaveLength(1);
    expect(ends).toHaveLength(1);

    const contextId = turnChanges[0]!.contextId;
    expect(contextId.length).toBeGreaterThan(0);
    expect(audio.every((frame) => frame.contextId === contextId)).toBe(true);
    expect(turnComplete[0]!.contextId).toBe(contextId);
    expect(ends[0]!.contextId).toBe(contextId);
    expect(audio.every((frame) => frame.sampleRateHz === 16_000)).toBe(true);
    expect(audio.every((frame) => frameDurationMs(frame) <= 20)).toBe(true);
    expect(adapter.sentAudio.length).toBeGreaterThan(0);

    await bridge.close();
    bus.stop();
    await started;
  });

  it("forwards a user.text_received turn to adapter.sendText (typed input), ignoring blank text", async () => {
    const adapter = new FakeRealtimeAdapter();
    const bridge = new RealtimeBridge(adapter);
    const bus = new PipelineBusImpl();
    buses.push(bus);

    const started = bus.start();
    await bridge.initialize(bus, {});

    bus.push(Route.Main, {
      kind: "user.text_received",
      contextId: "transport-turn",
      timestampMs: Date.now(),
      text: "when is the late-add deadline?",
    });
    bus.push(Route.Main, {
      kind: "user.text_received",
      contextId: "transport-turn",
      timestampMs: Date.now(),
      text: "   ",
    });

    await waitForCondition(() => adapter.sentText.length > 0);
    expect(adapter.sentText).toEqual(["when is the late-add deadline?"]);

    await bridge.close();
    bus.stop();
    await started;
  });

  it("with syrinxTurns, eos.turn_complete calls adapter.requestResponse exactly once", async () => {
    const adapter = new FakeRealtimeAdapter();
    const bridge = new RealtimeBridge(adapter, undefined, undefined, { syrinxTurns: true });
    const bus = new PipelineBusImpl();
    buses.push(bus);

    const started = bus.start();
    await bridge.initialize(bus, {});

    bus.push(Route.Main, {
      kind: "eos.turn_complete",
      contextId: "user-turn",
      timestampMs: Date.now(),
    });

    await waitForCondition(() => adapter.requestResponseCalls >= 1);
    expect(adapter.requestResponseCalls).toBe(1);

    await bridge.close();
    bus.stop();
    await started;
  });

  it("without syrinxTurns, eos.turn_complete does not call adapter.requestResponse", async () => {
    const adapter = new FakeRealtimeAdapter();
    const bridge = new RealtimeBridge(adapter);
    const bus = new PipelineBusImpl();
    buses.push(bus);

    const started = bus.start();
    await bridge.initialize(bus, {});

    bus.push(Route.Main, {
      kind: "eos.turn_complete",
      contextId: "user-turn",
      timestampMs: Date.now(),
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(adapter.requestResponseCalls).toBe(0);

    await bridge.close();
    bus.stop();
    await started;
  });

  it("syrinxTurns+textOnly: response_done does not re-trigger requestResponse via eos.turn_complete", async () => {
    const adapter = new FakeRealtimeAdapter();
    const bridge = new RealtimeBridge(adapter, undefined, undefined, {
      textOnly: true,
      syrinxTurns: true,
    });
    const bus = new PipelineBusImpl();
    buses.push(bus);

    const started = bus.start();
    await bridge.initialize(bus, {});

    // Endpointing owns the user-turn signal → one requestResponse.
    bus.push(Route.Main, {
      kind: "eos.turn_complete",
      contextId: "user-turn",
      timestampMs: Date.now(),
    });
    await waitForCondition(() => adapter.requestResponseCalls >= 1);
    expect(adapter.requestResponseCalls).toBe(1);

    // Full provider response cycle must not re-emit eos.turn_complete → requestResponse.
    adapter.emit({ type: "response_started" });
    adapter.emit({ type: "transcript", role: "assistant", text: "hi", final: true });
    adapter.emit({ type: "response_done" });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(adapter.requestResponseCalls).toBe(1);

    await bridge.close();
    bus.stop();
    await started;
  });

  it("mints a fresh contextId for each response_started (R1)", async () => {
    const adapter = new FakeRealtimeAdapter();
    const bridge = new RealtimeBridge(adapter);
    const bus = new PipelineBusImpl();
    buses.push(bus);
    const turnChanges: TurnChangePacket[] = [];
    bus.on("turn.change", (pkt) => { turnChanges.push(pkt as TurnChangePacket); });

    const started = bus.start();
    await bridge.initialize(bus, {});

    adapter.emit({ type: "response_started" });
    adapter.emit({ type: "response_done" });
    adapter.emit({ type: "response_started" });
    adapter.emit({ type: "response_done" });

    await waitForCondition(() => turnChanges.length >= 2);

    expect(turnChanges[0]!.contextId).not.toBe(turnChanges[1]!.contextId);
    expect(turnChanges[1]!.previousContextId).toBe(turnChanges[0]!.contextId);

    await bridge.close();
    bus.stop();
    await started;
  });

  it("R-04: mints contextId via globalThis.crypto.randomUUID without node:crypto", async () => {
    const adapter = new FakeRealtimeAdapter();
    const bridge = new RealtimeBridge(adapter);
    const bus = new PipelineBusImpl();
    buses.push(bus);
    const turnChanges: TurnChangePacket[] = [];
    bus.on("turn.change", (pkt) => { turnChanges.push(pkt as TurnChangePacket); });

    const started = bus.start();
    await bridge.initialize(bus, {});

    adapter.emit({ type: "response_started" });
    await waitForCondition(() => turnChanges.length >= 1);
    expect(turnChanges[0]!.contextId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    await bridge.close();
    bus.stop();
    await started;
  });

  it("runDelegate injects finish.text when the Reasoner yields no deltas (R-08)", async () => {
    const adapter = new FakeRealtimeAdapter();
    const answerText = "Submit the Late Add Petition via the Student Relations portal.";
    const reasoner: Reasoner = {
      stream: () => (async function* () {
        yield { type: "finish", reason: "stop", text: answerText };
      })(),
    };
    const bridge = new RealtimeBridge(adapter, reasoner);
    const bus = new PipelineBusImpl();
    buses.push(bus);
    const toolResults: LlmToolResultPacket[] = [];
    bus.on("llm.tool_result", (pkt) => { toolResults.push(pkt as LlmToolResultPacket); });

    const started = bus.start();
    await bridge.initialize(bus, {});

    adapter.emit({ type: "response_started" });
    adapter.emit({
      type: "tool_call",
      toolId: "call_delegate_1",
      toolName: "consult_knowledge",
      args: { query: "Can I still add Biology 101?" },
    });

    await waitForCondition(() => adapter.injectedToolResults.length === 1);

    // The bus packet keeps the raw answer; the front model receives the G1 envelope (default).
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]!.result).toBe(answerText);
    expect(adapter.injectedToolResults[0]!.toolId).toBe("call_delegate_1");
    expect(JSON.parse(adapter.injectedToolResults[0]!.text)).toEqual({
      response_text: answerText,
      require_repeat_verbatim: true,
    });

    await bridge.close();
    bus.stop();
    await started;
  });

  it("R-08: finish reason length uses accumulated text", async () => {
    const adapter = new FakeRealtimeAdapter();
    const reasoner: Reasoner = {
      stream: () => (async function* () {
        yield { type: "text-delta", text: "Partial " };
        yield { type: "finish", reason: "length", text: "Partial answer truncated" };
      })(),
    };
    const bridge = new RealtimeBridge(adapter, reasoner);
    const bus = new PipelineBusImpl();
    buses.push(bus);

    const started = bus.start();
    await bridge.initialize(bus, {});

    adapter.emit({ type: "response_started" });
    adapter.emit({
      type: "tool_call",
      toolId: "call_len",
      toolName: "consult_knowledge",
      args: { query: "long query" },
    });

    await waitForCondition(() => adapter.injectedToolResults.length === 1);
    expect(JSON.parse(adapter.injectedToolResults[0]!.text)).toMatchObject({ response_text: "Partial " });

    await bridge.close();
    bus.stop();
    await started;
  });

  it("G1/WBS-2: envelope carries the render directive when configured", async () => {
    const adapter = new FakeRealtimeAdapter();
    const reasoner: Reasoner = {
      stream: () => (async function* () {
        yield { type: "finish", reason: "stop", text: "The fee is 5000 rupees." };
      })(),
    };
    const bridge = new RealtimeBridge(adapter, reasoner, "consult_knowledge", {
      renderDirective: "translate_faithfully",
    });
    const bus = new PipelineBusImpl();
    buses.push(bus);

    const started = bus.start();
    await bridge.initialize(bus, {});

    adapter.emit({ type: "response_started" });
    adapter.emit({
      type: "tool_call",
      toolId: "call_env_1",
      toolName: "consult_knowledge",
      args: { query: "fees" },
    });

    await waitForCondition(() => adapter.injectedToolResults.length === 1);
    expect(JSON.parse(adapter.injectedToolResults[0]!.text)).toEqual({
      response_text: "The fee is 5000 rupees.",
      require_repeat_verbatim: true,
      render: "translate_faithfully",
    });

    await bridge.close();
    bus.stop();
    await started;
  });

  it('G1/WBS-2: toolResultFormat "string" opts out to the raw answer (pre-RFC behavior)', async () => {
    const adapter = new FakeRealtimeAdapter();
    const reasoner: Reasoner = {
      stream: () => (async function* () {
        yield { type: "finish", reason: "stop", text: "raw answer" };
      })(),
    };
    const bridge = new RealtimeBridge(adapter, reasoner, "consult_knowledge", {
      toolResultFormat: "string",
    });
    const bus = new PipelineBusImpl();
    buses.push(bus);

    const started = bus.start();
    await bridge.initialize(bus, {});

    adapter.emit({ type: "response_started" });
    adapter.emit({
      type: "tool_call",
      toolId: "call_env_2",
      toolName: "consult_knowledge",
      args: { query: "q" },
    });

    await waitForCondition(() => adapter.injectedToolResults.length === 1);
    expect(adapter.injectedToolResults[0]!.text).toBe("raw answer");

    await bridge.close();
    bus.stop();
    await started;
  });

  it("G2/WBS-1: delegate turn emits delegate.query then delegate.result on the Background route", async () => {
    const adapter = new FakeRealtimeAdapter();
    const reasoner: Reasoner = {
      stream: () => (async function* () {
        yield { type: "tool-call", toolId: "rag-1", toolName: "retrieve", args: { q: "deadline" } };
        yield { type: "tool-result", toolId: "rag-1", toolName: "retrieve", result: "chunk" };
        yield { type: "text-delta", text: "The deadline is March 31." };
        yield { type: "finish", reason: "stop", text: "The deadline is March 31." };
      })(),
    };
    const bridge = new RealtimeBridge(adapter, reasoner);
    const background: Array<{ route: Route; packet: VoicePacket }> = [];
    const bus = new PipelineBusImpl({
      onPacket: (route, packet) => {
        if (packet.kind.startsWith("delegate.")) background.push({ route, packet });
      },
    });
    buses.push(bus);

    const started = bus.start();
    await bridge.initialize(bus, {});

    adapter.emit({ type: "response_started" });
    adapter.emit({
      type: "tool_call",
      toolId: "call_obs_1",
      toolName: "consult_knowledge",
      args: { query: "When is the exam registration deadline?" },
    });

    await waitForCondition(() => adapter.injectedToolResults.length === 1);
    await waitForCondition(() => background.length === 2);

    expect(background.map((entry) => entry.route)).toEqual([Route.Background, Route.Background]);
    const [query, result] = background.map((entry) => entry.packet);
    expect(query).toMatchObject({
      kind: "delegate.query",
      query: "When is the exam registration deadline?",
      toolId: "call_obs_1",
      toolName: "consult_knowledge",
    });
    expect(query!.contextId).toBeTruthy();
    expect(result).toMatchObject({
      kind: "delegate.result",
      query: "When is the exam registration deadline?",
      answer: "The deadline is March 31.",
      grounded: true,
      toolId: "call_obs_1",
      toolName: "consult_knowledge",
      contextId: query!.contextId,
    });
    expect((result as DelegateResultPacket).durationMs).toBeGreaterThanOrEqual(0);

    await bridge.close();
    bus.stop();
    await started;
  });

  it("emits per-pass conversation metrics for delegated tool loops", async () => {
    const adapter = new FakeRealtimeAdapter();
    const reasoner: Reasoner = {
      stream: () => (async function* () {
        yield { type: "tool-call", toolId: "rag-1", toolName: "retrieve", args: { q: "fees" } };
        yield { type: "tool-result", toolId: "rag-1", toolName: "retrieve", result: "ten dollars" };
        yield { type: "text-delta", text: "The fee is ten dollars." };
        yield { type: "finish", reason: "stop", text: "The fee is ten dollars." };
      })(),
    };
    const bridge = new RealtimeBridge(adapter, reasoner);
    const metrics: Array<{ name: string; value: string }> = [];
    const bus = new PipelineBusImpl({
      onPacket: (_route, packet) => {
        if (packet.kind === "metric.conversation") {
          const metric = packet as unknown as { name: string; value: string };
          metrics.push({ name: metric.name, value: metric.value });
        }
      },
    });
    buses.push(bus);

    const started = bus.start();
    await bridge.initialize(bus, {});
    adapter.emit({ type: "response_started" });
    adapter.emit({
      type: "tool_call",
      toolId: "call_metrics_1",
      toolName: "consult_knowledge",
      args: { query: "What is the fee?" },
    });

    await waitForCondition(() => adapter.injectedToolResults.length === 1);
    expect(metrics.filter((metric) => metric.name === "llm.call_started")).toHaveLength(2);
    expect(metrics.filter((metric) => metric.name === "llm.pass_ttft_ms")).toHaveLength(2);
    expect(metrics.filter((metric) => metric.name === "llm.pass_ttft_ms").every((metric) => Number(metric.value) >= 0)).toBe(true);

    await bridge.close();
    bus.stop();
    await started;
  });

  it("G2/WBS-1: delegate.result grounded=false when the reasoner used no tool", async () => {
    const adapter = new FakeRealtimeAdapter();
    const reasoner: Reasoner = {
      stream: () => (async function* () {
        yield { type: "text-delta", text: "From memory." };
        yield { type: "finish", reason: "stop", text: "From memory." };
      })(),
    };
    const bridge = new RealtimeBridge(adapter, reasoner);
    const results: DelegateResultPacket[] = [];
    const bus = new PipelineBusImpl();
    buses.push(bus);
    bus.on("delegate.result", (pkt) => { results.push(pkt as DelegateResultPacket); });

    const started = bus.start();
    await bridge.initialize(bus, {});

    adapter.emit({ type: "response_started" });
    adapter.emit({
      type: "tool_call",
      toolId: "call_obs_2",
      toolName: "consult_knowledge",
      args: { query: "ungrounded" },
    });

    await waitForCondition(() => results.length === 1);
    expect(results[0]!.grounded).toBe(false);

    await bridge.close();
    bus.stop();
    await started;
  });

  it("surfaces control parts and continues to the delegate result", async () => {
    const adapter = new FakeRealtimeAdapter();
    const reasoner: Reasoner = {
      stream: () => (async function* () {
        yield { type: "control", name: "handoff", payload: { targetAgent: "billing" } };
        yield { type: "text-delta", text: "Billing can help." };
        yield { type: "finish", reason: "stop", text: "Billing can help." };
      })(),
    };
    const bridge = new RealtimeBridge(adapter, reasoner);
    const results: DelegateResultPacket[] = [];
    const bus = new PipelineBusImpl();
    buses.push(bus);
    bus.on("delegate.result", (pkt) => { results.push(pkt as DelegateResultPacket); });

    const started = bus.start();
    await bridge.initialize(bus, {});
    adapter.emit({ type: "response_started" });
    adapter.emit({
      type: "tool_call",
      toolId: "call_control",
      toolName: "consult_knowledge",
      args: { query: "billing" },
    });

    await waitForCondition(() => results.length === 2);
    expect(results[0]).toMatchObject({
      control: { name: "handoff", payload: { targetAgent: "billing" } },
    });
    expect(results[1]).toMatchObject({ answer: "Billing can help." });
    expect(adapter.injectedToolResults[0]!.text).toContain("Billing can help.");

    await bridge.close();
    bus.stop();
    await started;
  });

  it("forwards a client-message part straight to the wire, bypassing the delegate tool-result relay", async () => {
    const adapter = new FakeRealtimeAdapter();
    const reasoner: Reasoner = {
      stream: () => (async function* () {
        yield { type: "client-message", payload: { card: "invoice" } };
        yield { type: "text-delta", text: "Here is your invoice." };
        yield { type: "finish", reason: "stop", text: "Here is your invoice." };
      })(),
    };
    const bridge = new RealtimeBridge(adapter, reasoner);
    const clientMessages: Array<Record<string, unknown>> = [];
    const results: DelegateResultPacket[] = [];
    const bus = new PipelineBusImpl();
    buses.push(bus);
    bus.on("llm.client_message", (pkt) => { clientMessages.push(pkt as unknown as Record<string, unknown>); });
    bus.on("delegate.result", (pkt) => { results.push(pkt as DelegateResultPacket); });

    const started = bus.start();
    await bridge.initialize(bus, {});
    adapter.emit({ type: "response_started" });
    adapter.emit({
      type: "tool_call",
      toolId: "call_cm",
      toolName: "consult_knowledge",
      args: { query: "invoice" },
    });

    await waitForCondition(() => results.length === 1);

    expect(clientMessages).toEqual([
      expect.objectContaining({ kind: "llm.client_message", payload: { card: "invoice" } }),
    ]);
    // The delegate's front-model tool-result relay never sees this payload — it
    // must not leak into what gets spoken/injected back to the realtime front.
    expect(adapter.injectedToolResults[0]!.text).not.toContain("card");
    expect(results[0]).toMatchObject({ answer: "Here is your invoice." });

    await bridge.close();
    bus.stop();
    await started;
  });

  it("surfaces a blocked part as a safe terminal delegate result", async () => {
    const adapter = new FakeRealtimeAdapter();
    const reasoner: Reasoner = {
      stream: () => (async function* () {
        yield {
          type: "blocked",
          userFacingMessage: "I cannot help with that request.",
          payload: { moderator: "safety" },
        };
      })(),
    };
    const bridge = new RealtimeBridge(adapter, reasoner);
    const results: DelegateResultPacket[] = [];
    const bus = new PipelineBusImpl();
    buses.push(bus);
    bus.on("delegate.result", (pkt) => { results.push(pkt as DelegateResultPacket); });

    const started = bus.start();
    await bridge.initialize(bus, {});
    adapter.emit({ type: "response_started" });
    adapter.emit({
      type: "tool_call",
      toolId: "call_blocked",
      toolName: "consult_knowledge",
      args: { query: "unsafe" },
    });

    await waitForCondition(() => results.length === 1);
    expect(results[0]).toMatchObject({
      answer: "I cannot help with that request.",
      blocked: {
        userFacingMessage: "I cannot help with that request.",
        payload: { moderator: "safety" },
      },
    });
    expect(adapter.injectedToolResults[0]!.text).toContain("I cannot help with that request.");

    await bridge.close();
    bus.stop();
    await started;
  });

  it("G2/WBS-1: failed delegate emits delegate.query but no delegate.result", async () => {
    const adapter = new FakeRealtimeAdapter();
    const reasoner: Reasoner = {
      stream: () => (async function* () {
        yield { type: "error", cause: new Error("brain down"), recoverable: false };
      })(),
    };
    const bridge = new RealtimeBridge(adapter, reasoner);
    const queries: DelegateQueryPacket[] = [];
    const results: DelegateResultPacket[] = [];
    const errors: LlmErrorPacket[] = [];
    const bus = new PipelineBusImpl();
    buses.push(bus);
    bus.on("delegate.query", (pkt) => { queries.push(pkt as DelegateQueryPacket); });
    bus.on("delegate.result", (pkt) => { results.push(pkt as DelegateResultPacket); });
    bus.on("llm.error", (pkt) => { errors.push(pkt as LlmErrorPacket); });

    const started = bus.start();
    await bridge.initialize(bus, {});

    adapter.emit({ type: "response_started" });
    adapter.emit({
      type: "tool_call",
      toolId: "call_obs_3",
      toolName: "consult_knowledge",
      args: { query: "will fail" },
    });

    await waitForCondition(() => errors.length === 1);
    expect(queries).toHaveLength(1);
    expect(results).toHaveLength(0);

    await bridge.close();
    bus.stop();
    await started;
  });

  it("R-08: recoverable error surfaces llm.error without injecting empty output", async () => {
    const adapter = new FakeRealtimeAdapter();
    const reasoner: Reasoner = {
      stream: () => (async function* () {
        yield { type: "error", cause: new Error("rate limited"), recoverable: true };
      })(),
    };
    const bridge = new RealtimeBridge(adapter, reasoner);
    const bus = new PipelineBusImpl();
    buses.push(bus);
    const errors: LlmErrorPacket[] = [];
    bus.on("llm.error", (pkt) => { errors.push(pkt as LlmErrorPacket); });

    const started = bus.start();
    await bridge.initialize(bus, {});

    adapter.emit({ type: "response_started" });
    adapter.emit({
      type: "tool_call",
      toolId: "call_recover",
      toolName: "consult_knowledge",
      args: { query: "test" },
    });

    await waitForCondition(() => errors.length === 1);
    expect(errors[0]!.isRecoverable).toBe(true);
    expect(adapter.injectedToolResults).toHaveLength(0);

    await bridge.close();
    bus.stop();
    await started;
  });

  it("R-08: nonrecoverable error emits llm.error without injecting output", async () => {
    const adapter = new FakeRealtimeAdapter();
    const reasoner: Reasoner = {
      stream: () => (async function* () {
        yield { type: "error", cause: new Error("auth failed"), recoverable: false };
      })(),
    };
    const bridge = new RealtimeBridge(adapter, reasoner);
    const bus = new PipelineBusImpl();
    buses.push(bus);
    const errors: LlmErrorPacket[] = [];
    bus.on("llm.error", (pkt) => { errors.push(pkt as LlmErrorPacket); });

    const started = bus.start();
    await bridge.initialize(bus, {});

    adapter.emit({ type: "response_started" });
    adapter.emit({
      type: "tool_call",
      toolId: "call_fatal",
      toolName: "consult_knowledge",
      args: { query: "test" },
    });

    await waitForCondition(() => errors.length === 1);
    expect(errors[0]!.isRecoverable).toBe(false);
    expect(adapter.injectedToolResults).toHaveLength(0);

    await bridge.close();
    bus.stop();
    await started;
  });

  it("runDelegate rejects suspended Reasoner without injecting an answer (R-08)", async () => {
    const adapter = new FakeRealtimeAdapter();
    const reasoner: Reasoner = {
      stream: () => (async function* () {
        yield { type: "suspended", runId: "run-suspended-1", payload: { step: "approval" } };
      })(),
    };
    const bridge = new RealtimeBridge(adapter, reasoner);
    const bus = new PipelineBusImpl();
    buses.push(bus);
    const toolResults: LlmToolResultPacket[] = [];
    const errors: LlmErrorPacket[] = [];
    bus.on("llm.tool_result", (pkt) => { toolResults.push(pkt as LlmToolResultPacket); });
    bus.on("llm.error", (pkt) => { errors.push(pkt as LlmErrorPacket); });

    const started = bus.start();
    await bridge.initialize(bus, {});

    adapter.emit({ type: "response_started" });
    adapter.emit({
      type: "tool_call",
      toolId: "call_delegate_2",
      toolName: "consult_knowledge",
      args: { query: "Need advisor approval" },
    });

    await waitForCondition(() => errors.length === 1);

    expect(adapter.injectedToolResults).toHaveLength(0);
    expect(toolResults).toHaveLength(0);

    await bridge.close();
    bus.stop();
    await started;
  });

  it("R-07: mismatched tool_call name emits recoverable llm.error instead of silent ignore", async () => {
    const adapter = new FakeRealtimeAdapter();
    const reasoner: Reasoner = {
      stream: () => (async function* () {
        yield { type: "finish", reason: "stop", text: "never called" };
      })(),
    };
    const bridge = new RealtimeBridge(adapter, reasoner, "consult_knowledge");
    const bus = new PipelineBusImpl();
    buses.push(bus);
    const errors: LlmErrorPacket[] = [];
    bus.on("llm.error", (pkt) => { errors.push(pkt as LlmErrorPacket); });

    const started = bus.start();
    await bridge.initialize(bus, {});

    adapter.emit({ type: "response_started" });
    adapter.emit({
      type: "tool_call",
      toolId: "call_wrong",
      toolName: "wrong_tool",
      args: { query: "test" },
    });

    await waitForCondition(() => errors.length === 1);
    expect(errors[0]!.isRecoverable).toBe(true);
    expect(errors[0]!.cause.message).toContain("wrong_tool");
    expect(adapter.injectedToolResults).toHaveLength(0);

    await bridge.close();
    bus.stop();
    await started;
  });

  it("R-08: delegate tool_call missing the query argument emits recoverable error, never calls reasoner", async () => {
    const adapter = new FakeRealtimeAdapter();
    let reasonerCalled = false;
    const reasoner: Reasoner = {
      stream: () => {
        reasonerCalled = true;
        return (async function* () {
          yield { type: "finish", reason: "stop", text: "should not run" };
        })();
      },
    };
    const bridge = new RealtimeBridge(adapter, reasoner, "consult_knowledge");
    const bus = new PipelineBusImpl();
    buses.push(bus);
    const errors: LlmErrorPacket[] = [];
    bus.on("llm.error", (pkt) => { errors.push(pkt as LlmErrorPacket); });

    const started = bus.start();
    await bridge.initialize(bus, {});

    adapter.emit({ type: "response_started" });
    adapter.emit({
      type: "tool_call",
      toolId: "call_noarg",
      toolName: "consult_knowledge",
      args: { question: "wrong arg name" },
    });

    await waitForCondition(() => errors.length === 1);
    expect(errors[0]!.isRecoverable).toBe(true);
    expect(errors[0]!.cause.message).toContain("query");
    expect(reasonerCalled).toBe(false);
    expect(adapter.injectedToolResults).toHaveLength(0);

    await bridge.close();
    bus.stop();
    await started;
  });

  it("R-09: contextProvider messages are passed to reasoner.stream", async () => {
    const adapter = new FakeRealtimeAdapter();
    const prior: ReasonerMessage[] = [
      { role: "user", content: "prior question" },
      { role: "assistant", content: "prior answer" },
    ];
    let receivedMessages: readonly ReasonerMessage[] | undefined;
    const reasoner: Reasoner = {
      stream: (turn) => {
        receivedMessages = turn.messages;
        return (async function* () {
          yield { type: "finish", reason: "stop", text: "with context" };
        })();
      },
    };
    const bridge = new RealtimeBridge(adapter, reasoner, "consult_knowledge", {
      contextProvider: () => prior,
    });
    const bus = new PipelineBusImpl();
    buses.push(bus);

    const started = bus.start();
    await bridge.initialize(bus, {});

    adapter.emit({ type: "response_started" });
    adapter.emit({
      type: "tool_call",
      toolId: "call_ctx",
      toolName: "consult_knowledge",
      args: { query: "follow up" },
    });

    await waitForCondition(() => adapter.injectedToolResults.length === 1);
    expect(receivedMessages).toEqual(prior);

    await bridge.close();
    bus.stop();
    await started;
  });

  it("R-10: routes a non-delegate tool call to onFrontToolCall and injects its result (no error)", async () => {
    const adapter = new FakeRealtimeAdapter();
    const reasoner: Reasoner = {
      stream: () => (async function* () {
        yield { type: "finish", reason: "stop", text: "delegate not called" };
      })(),
    };
    const frontCalls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
    const bridge = new RealtimeBridge(adapter, reasoner, "consult_knowledge", {
      onFrontToolCall: (c) => {
        frontCalls.push({ toolName: c.toolName, args: c.args });
        return "acknowledged";
      },
    });
    const bus = new PipelineBusImpl();
    buses.push(bus);
    const errors: LlmErrorPacket[] = [];
    bus.on("llm.error", (pkt) => { errors.push(pkt as LlmErrorPacket); });

    const started = bus.start();
    await bridge.initialize(bus, {});

    adapter.emit({ type: "response_started" });
    adapter.emit({ type: "tool_call", toolId: "call_front", toolName: "wait_for_user", args: { reason: "hold music" } });

    await waitForCondition(() => adapter.injectedToolResults.length === 1);
    expect(frontCalls).toEqual([{ toolName: "wait_for_user", args: { reason: "hold music" } }]);
    expect(adapter.injectedToolResults[0]).toEqual({ toolId: "call_front", text: "acknowledged" });
    expect(errors).toEqual([]); // front tools must NOT abort the turn

    await bridge.close();
    bus.stop();
    await started;
  });

  it("R-11: forwards the full tool-call args to the Reasoner, not just the query", async () => {
    const adapter = new FakeRealtimeAdapter();
    let receivedArgs: Record<string, unknown> | undefined;
    const reasoner: Reasoner = {
      stream: (turn) => {
        receivedArgs = turn.toolArgs;
        return (async function* () {
          yield { type: "finish", reason: "stop", text: "ok" };
        })();
      },
    };
    const bridge = new RealtimeBridge(adapter, reasoner, "consult_knowledge");
    const bus = new PipelineBusImpl();
    buses.push(bus);

    const started = bus.start();
    await bridge.initialize(bus, {});

    adapter.emit({ type: "response_started" });
    adapter.emit({
      type: "tool_call",
      toolId: "call_args",
      toolName: "consult_knowledge",
      args: { query: "What's the deadline?", reply_language: "si" },
    });

    await waitForCondition(() => adapter.injectedToolResults.length === 1);
    expect(receivedArgs).toEqual({ query: "What's the deadline?", reply_language: "si" });

    await bridge.close();
    bus.stop();
    await started;
  });

  it("R-13: surfaces the assistant transcript as llm.delta/llm.done (client captions data)", async () => {
    // Regression guard for #6: a realtime turn's assistant words must reach the bus as
    // llm.delta/llm.done — VoiceAgentSession turns those into agent_text_delta/agent_finished,
    // which the edge protocol forwards to the client as agent_chunk/agent_end.
    const adapter = new FakeRealtimeAdapter();
    const bridge = new RealtimeBridge(adapter);
    const bus = new PipelineBusImpl();
    buses.push(bus);
    const deltas: LlmDeltaPacket[] = [];
    const dones: LlmResponseDonePacket[] = [];
    bus.on("llm.delta", (pkt) => { deltas.push(pkt as LlmDeltaPacket); });
    bus.on("llm.done", (pkt) => { dones.push(pkt as LlmResponseDonePacket); });

    const started = bus.start();
    await bridge.initialize(bus, {});

    adapter.emit({ type: "response_started" });
    adapter.emit({ type: "transcript", role: "assistant", text: "The deadline is March 31.", final: true });
    adapter.emit({ type: "response_done" });

    await waitForCondition(() => dones.length === 1);
    expect(deltas.map((d) => d.text).join("")).toContain("The deadline is March 31.");
    expect(dones[0]!.text).toContain("The deadline is March 31.");

    await bridge.close();
    bus.stop();
    await started;
  });

  it("pushes exactly one usage.recorded packet on Route.Background with stage llm for a native turn carrying usage", async () => {
    const adapter = new FakeRealtimeAdapter();
    const bridge = new RealtimeBridge(adapter);
    const recorded: Array<{ route: Route; packet: VoicePacket }> = [];
    const bus = new PipelineBusImpl({
      onPacket: (route, packet) => {
        if (packet.kind === "usage.recorded") recorded.push({ route, packet });
      },
    });
    buses.push(bus);

    const started = bus.start();
    await bridge.initialize(bus, {});

    adapter.emit({ type: "response_started" });
    adapter.emit({
      type: "response_done",
      usage: { inputTokens: 120, outputTokens: 45, totalTokens: 165 },
    });

    await waitForCondition(() => recorded.length >= 1);
    // Give any accidental second emission a chance to land before asserting the count.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.route).toBe(Route.Background);
    expect(recorded[0]!.packet).toMatchObject({
      kind: "usage.recorded",
      stage: "llm",
      inputTokens: 120,
      outputTokens: 45,
      totalTokens: 165,
    } satisfies Partial<UsageRecordedPacket>);

    await bridge.close();
    bus.stop();
    await started;
  });

  it("pushes vad.speech_ended when the realtime provider reports speech stopped", async () => {
    const adapter = new FakeRealtimeAdapter();
    const bridge = new RealtimeBridge(adapter);
    const bus = new PipelineBusImpl();
    buses.push(bus);
    const ended: unknown[] = [];
    bus.on("vad.speech_ended", (pkt) => { ended.push(pkt); });

    const started = bus.start();
    await bridge.initialize(bus, {});

    adapter.emit({ type: "speech_stopped" });
    adapter.emit({ type: "response_started" });

    await waitForCondition(() => ended.length === 1);
    expect(ended[0]).toMatchObject({
      kind: "vad.speech_ended",
      contextId: expect.any(String),
      timestampMs: expect.any(Number),
    });

    await bridge.close();
    bus.stop();
    await started;
  });

  it("streams native assistant transcript deltas onto the llm bus before response completion", async () => {
    const adapter = new FakeRealtimeAdapter();
    const bridge = new RealtimeBridge(adapter);
    const bus = new PipelineBusImpl();
    buses.push(bus);
    const deltas: LlmDeltaPacket[] = [];
    bus.on("llm.delta", (pkt) => { deltas.push(pkt as LlmDeltaPacket); });

    const started = bus.start();
    await bridge.initialize(bus, {});

    adapter.emit({ type: "response_started" });
    adapter.emit({ type: "transcript", role: "assistant", text: "The fee is ten dollars.", final: false });

    await waitForCondition(() => deltas.length === 1);
    expect(deltas[0]).toMatchObject({
      kind: "llm.delta",
      text: "The fee is ten dollars.",
    });

    await bridge.close();
    bus.stop();
    await started;
  });

  it("produces a non-empty turn-latency breakdown for a native turn", async () => {
    const adapter = new FakeRealtimeAdapter();
    const bridge = new RealtimeBridge(adapter);
    const session = new VoiceAgentSession({ plugins: {} });
    session.registerPlugin("realtime", bridge);
    const events: Array<Record<string, unknown>> = [];
    session.on("turn_latency", (event) => { events.push(event); });

    await session.start();
    adapter.emit({ type: "speech_stopped" });
    adapter.emit({ type: "response_started" });
    adapter.emit({ type: "transcript", role: "assistant", text: "The fee is ten dollars.", final: false });
    adapter.emit({ type: "response_started" });
    adapter.emit({ type: "audio", pcm16: frameSizedPcm24k(), sampleRateHz: 24_000 });
    adapter.emit({ type: "response_done" });

    await waitForCondition(() => events.length === 1);
    expect(events[0]).toEqual(expect.objectContaining({
      anchor: "speech_end",
      llmTtftMs: expect.any(Number),
      textAggregationMs: expect.any(Number),
      ttsTtfbMs: expect.any(Number),
      unattributedMs: expect.any(Number),
    }));

    await session.close();
  });

  it("surfaces a delta-only assistant transcript (Gemini Live: no final transcript event)", async () => {
    // Gemini Live streams the assistant transcript as non-final fragments and never emits a
    // final transcript. The bridge must still surface the concatenated words as llm.delta/llm.done
    // so client captions work — without double-counting providers (OpenAI) that DO send a final.
    const adapter = new FakeRealtimeAdapter();
    const bridge = new RealtimeBridge(adapter);
    const bus = new PipelineBusImpl();
    buses.push(bus);
    const dones: LlmResponseDonePacket[] = [];
    bus.on("llm.done", (pkt) => { dones.push(pkt as LlmResponseDonePacket); });

    const started = bus.start();
    await bridge.initialize(bus, {});

    adapter.emit({ type: "response_started" });
    adapter.emit({ type: "transcript", role: "assistant", text: "The capital", final: false });
    adapter.emit({ type: "transcript", role: "assistant", text: " of France", final: false });
    adapter.emit({ type: "transcript", role: "assistant", text: " is", final: false });
    adapter.emit({ type: "transcript", role: "assistant", text: " Paris.", final: false });
    adapter.emit({ type: "response_done" });

    await waitForCondition(() => dones.length === 1);
    expect(dones[0]!.text).toBe("The capital of France is Paris.");

    await bridge.close();
    bus.stop();
    await started;
  });

  it("prefers the final transcript over deltas (OpenAI: deltas + final, no double-count)", async () => {
    const adapter = new FakeRealtimeAdapter();
    const bridge = new RealtimeBridge(adapter);
    const bus = new PipelineBusImpl();
    buses.push(bus);
    const dones: LlmResponseDonePacket[] = [];
    bus.on("llm.done", (pkt) => { dones.push(pkt as LlmResponseDonePacket); });

    const started = bus.start();
    await bridge.initialize(bus, {});

    adapter.emit({ type: "response_started" });
    adapter.emit({ type: "transcript", role: "assistant", text: "Let me ", final: false });
    adapter.emit({ type: "transcript", role: "assistant", text: "check that.", final: false });
    adapter.emit({ type: "transcript", role: "assistant", text: "Let me check that.", final: true });
    adapter.emit({ type: "response_done" });

    await waitForCondition(() => dones.length === 1);
    expect(dones[0]!.text).toBe("Let me check that.");

    await bridge.close();
    bus.stop();
    await started;
  });

  it("R-12: coalesces tiny audio deltas and never emits odd-length tts.audio", async () => {
    const adapter = new FakeRealtimeAdapter();
    const bridge = new RealtimeBridge(adapter);
    const bus = new PipelineBusImpl();
    buses.push(bus);
    const audio: TextToSpeechAudioPacket[] = [];
    bus.on("tts.audio", (pkt) => { audio.push(pkt as TextToSpeechAudioPacket); });

    const started = bus.start();
    await bridge.initialize(bus, {});

    adapter.emit({ type: "response_started" });
    adapter.emit({ type: "audio", pcm16: new Uint8Array([1, 2]), sampleRateHz: 24_000 });
    adapter.emit({ type: "audio", pcm16: new Uint8Array([3, 4]), sampleRateHz: 24_000 });
    expect(audio).toHaveLength(0);

    adapter.emit({ type: "audio", pcm16: new Uint8Array([5]), sampleRateHz: 24_000 });
    expect(audio).toHaveLength(0);

    adapter.emit({ type: "response_done" });
    await waitForCondition(() => audio.length > 0);

    expect(audio.every((frame) => frame.audio.byteLength % 2 === 0)).toBe(true);
    expect(audio.every((frame) => frame.audio.byteLength <= 640 || frameDurationMs(frame) <= 20)).toBe(true);

    await bridge.close();
    bus.stop();
    await started;
  });

  it("R-13: adapter event handler throw emits llm.error; adapter close exits quietly", async () => {
    const adapter = new FakeRealtimeAdapter();
    const bridge = new RealtimeBridge(adapter);
    const bus = new PipelineBusImpl();
    buses.push(bus);
    const errors: LlmErrorPacket[] = [];
    bus.on("llm.error", (pkt) => { errors.push(pkt as LlmErrorPacket); });

    const started = bus.start();
    await bridge.initialize(bus, {});

    const originalRandomUUID = globalThis.crypto.randomUUID.bind(globalThis.crypto);
    globalThis.crypto.randomUUID = () => {
      throw new Error("handler boom");
    };
    try {
      adapter.emit({ type: "response_started" });
      await waitForCondition(() => errors.length === 1);
      expect(errors[0]!.isRecoverable).toBe(false);
      expect(errors[0]!.cause.message).toBe("handler boom");
    } finally {
      globalThis.crypto.randomUUID = originalRandomUUID;
    }

    const errorsBeforeClose = errors.length;
    await bridge.close();
    expect(errors.length).toBe(errorsBeforeClose);

    bus.stop();
    await started;
  });

  it("does not emit interrupt.detected when emitsServerSpeechStarted is false", async () => {
    const adapter = new FakeRealtimeAdapter({ emitsServerSpeechStarted: false });
    const bridge = new RealtimeBridge(adapter);
    const bus = new PipelineBusImpl();
    buses.push(bus);
    const interrupts: Array<{ kind: string }> = [];
    bus.on("interrupt.detected", (pkt) => { interrupts.push(pkt as { kind: string }); });

    const started = bus.start();
    await bridge.initialize(bus, {});

    adapter.emit({ type: "response_started" });
    adapter.emit({ type: "speech_started" });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(interrupts).toHaveLength(0);

    await bridge.close();
    bus.stop();
    await started;
  });

  it("double-barge-in: second turn tts.audio is not dropped after barge-in (R1, R3)", async () => {
    const adapter = new FakeRealtimeAdapter();
    let delegateSignal: AbortSignal | undefined;
    const reasoner: Reasoner = {
      stream: ({ signal }) => {
        delegateSignal = signal;
        return (async function* () {
          await new Promise((resolve) => setTimeout(resolve, 60_000));
          yield { type: "finish", reason: "stop", text: "never" };
        })();
      },
    };
    const bridge = new RealtimeBridge(adapter, reasoner);
    const session = new VoiceAgentSession({
      plugins: { realtime: {} },
      endpointingOwner: "timer",
      minInterruptionMs: 0,
    });
    session.registerPlugin("realtime", bridge);

    const turnChanges: TurnChangePacket[] = [];
    const recorded: RecordAssistantAudioPacket[] = [];
    const interruptTts: InterruptTtsPacket[] = [];

    session.bus.on("turn.change", (pkt) => { turnChanges.push(pkt as TurnChangePacket); });
    session.bus.on("record.assistant_audio", (pkt) => {
      const p = pkt as RecordAssistantAudioPacket;
      if (!p.truncate) recorded.push(p);
    });
    session.bus.on("interrupt.tts", (pkt) => { interruptTts.push(pkt as InterruptTtsPacket); });

    await session.start();

    adapter.emit({ type: "response_started" });
    await waitForCondition(() => turnChanges.length >= 1);
    const contextA = turnChanges[0]!.contextId;

    adapter.emit({
      type: "audio",
      pcm16: pcmFromSamples([100, 200, 300, 400]),
      sampleRateHz: 24_000,
    });
    adapter.emit({ type: "speech_started" });
    await waitForCondition(() => interruptTts.length >= 1);
    expect(adapter.cancelCalls.length).toBeGreaterThanOrEqual(1);
    expect(interruptTts[0]!.contextId).toBe(contextA);

    adapter.emit({ type: "response_done" });

    adapter.emit({ type: "response_started" });
    await waitForCondition(() => turnChanges.length >= 2);
    const contextB = turnChanges[1]!.contextId;
    expect(contextB).not.toBe(contextA);

    adapter.emit({
      type: "audio",
      pcm16: frameSizedPcm24k(),
      sampleRateHz: 24_000,
    });
    await waitForCondition(() => recorded.some((p) => p.contextId === contextB));

    adapter.emit({ type: "speech_started" });
    await waitForCondition(() => interruptTts.length >= 2);
    expect(adapter.cancelCalls.length).toBeGreaterThanOrEqual(2);

    adapter.emit({ type: "response_done" });

    adapter.emit({ type: "response_started" });
    await waitForCondition(() => turnChanges.length >= 3);
    const contextC = turnChanges[2]!.contextId;

    adapter.emit({
      type: "audio",
      pcm16: frameSizedPcm24k(),
      sampleRateHz: 24_000,
    });
    await waitForCondition(() => recorded.some((p) => p.contextId === contextC));

    expect(recorded.filter((p) => p.contextId === contextB).length).toBeGreaterThan(0);
    expect(recorded.filter((p) => p.contextId === contextC).length).toBeGreaterThan(0);

    adapter.emit({ type: "response_started" });
    await waitForCondition(() => turnChanges.length >= 4);
    const contextDelegate = turnChanges[3]!.contextId;
    adapter.emit({
      type: "tool_call",
      toolId: "call_barge_delegate",
      toolName: "consult_knowledge",
      args: { query: "late add policy" },
    });
    await waitForCondition(() => delegateSignal !== undefined);
    session.bus.push(Route.Critical, {
      kind: "interrupt.tts",
      contextId: contextDelegate,
      timestampMs: Date.now(),
    });
    await waitForCondition(() => delegateSignal!.aborted);

    await session.close();
  });

  it("BUG1: a barge-in DURING the reasoner gap drains speech_started, fires interrupt.detected, and aborts the delegate before it completes", async () => {
    // The barge-in is delivered on the adapter EVENT STREAM (not a direct interrupt.tts bus
    // push). With the old serial pump, awaiting the delegate froze the pump for the whole
    // reasoner gap, so this speech_started stayed queued and never became interrupt.detected —
    // the unwanted answer was then voiced over the user. The delegate must run off the pump.
    const adapter = new FakeRealtimeAdapter();
    let delegateSignal: AbortSignal | undefined;
    let reasonerCompleted = false;
    const reasoner: Reasoner = {
      stream: ({ signal }) => {
        delegateSignal = signal;
        return (async function* () {
          // The ~1.5–3s reasoner "thinking gap", exaggerated: the barge-in must abort it, not
          // wait it out.
          await new Promise((resolve) => setTimeout(resolve, 60_000));
          reasonerCompleted = true;
          yield { type: "finish", reason: "stop", text: "unwanted late answer" };
        })();
      },
    };
    const bridge = new RealtimeBridge(adapter, reasoner);
    const session = new VoiceAgentSession({
      plugins: { realtime: {} },
      endpointingOwner: "timer",
      minInterruptionMs: 0,
    });
    session.registerPlugin("realtime", bridge);

    const interruptDetected: InterruptionDetectedPacket[] = [];
    const turnChanges: TurnChangePacket[] = [];
    session.bus.on("interrupt.detected", (pkt) => { interruptDetected.push(pkt as InterruptionDetectedPacket); });
    session.bus.on("turn.change", (pkt) => { turnChanges.push(pkt as TurnChangePacket); });

    await session.start();

    // Turn A: front model responds, emits audio, then calls the delegate tool.
    adapter.emit({ type: "response_started" });
    await waitForCondition(() => turnChanges.length >= 1);
    adapter.emit({ type: "audio", pcm16: frameSizedPcm24k(), sampleRateHz: 24_000 });
    adapter.emit({
      type: "tool_call",
      toolId: "call_gap_delegate",
      toolName: "consult_knowledge",
      args: { query: "late add policy" },
    });

    // Delegate is now in flight (reasoner sleeping) — signal wired, not yet aborted.
    await waitForCondition(() => delegateSignal !== undefined);
    expect(delegateSignal!.aborted).toBe(false);

    // User barges in mid-gap, on the adapter event stream.
    adapter.emit({ type: "speech_started" });

    // The pump kept draining: speech_started → interrupt.detected → session → interrupt.tts → abort.
    await waitForCondition(() => interruptDetected.length >= 1);
    await waitForCondition(() => delegateSignal!.aborted);
    expect(reasonerCompleted).toBe(false);

    await session.close();
  });

  it("aborts the reasoner's AbortSignal when the front model reports tool_call_cancelled, and never answers it", async () => {
    const adapter = new FakeRealtimeAdapter();
    let delegateSignal: AbortSignal | undefined;
    let reasonerCompleted = false;
    const reasoner: Reasoner = {
      stream: ({ signal }) => {
        delegateSignal = signal;
        return (async function* () {
          // A slow reasoner turn — the cancellation must abort it, not wait it out.
          await new Promise((resolve) => setTimeout(resolve, 60_000));
          reasonerCompleted = true;
          yield { type: "finish", reason: "stop", text: "never sent — call was cancelled" };
        })();
      },
    };
    const bridge = new RealtimeBridge(adapter, reasoner);
    const session = new VoiceAgentSession({
      plugins: { realtime: {} },
      endpointingOwner: "timer",
      minInterruptionMs: 0,
    });
    session.registerPlugin("realtime", bridge);

    const turnChanges: TurnChangePacket[] = [];
    session.bus.on("turn.change", (pkt) => { turnChanges.push(pkt as TurnChangePacket); });

    await session.start();

    adapter.emit({ type: "response_started" });
    await waitForCondition(() => turnChanges.length >= 1);
    adapter.emit({
      type: "tool_call",
      toolId: "call_cancelled_by_gemini",
      toolName: "consult_knowledge",
      args: { query: "late add policy" },
    });

    await waitForCondition(() => delegateSignal !== undefined);
    expect(delegateSignal!.aborted).toBe(false);

    adapter.emit({ type: "tool_call_cancelled", toolIds: ["call_cancelled_by_gemini"] });

    await waitForCondition(() => delegateSignal!.aborted);
    expect(reasonerCompleted).toBe(false);
    expect(adapter.injectedToolResults).toEqual([]);

    await session.close();
  });

  it("ignores a tool_call_cancelled naming an id that is not the in-flight delegate's", async () => {
    const adapter = new FakeRealtimeAdapter();
    let delegateSignal: AbortSignal | undefined;
    const reasoner: Reasoner = {
      stream: ({ signal }) => {
        delegateSignal = signal;
        return (async function* () {
          await new Promise((resolve) => setTimeout(resolve, 60_000));
          yield { type: "finish", reason: "stop", text: "unrelated cancellation must not stop this" };
        })();
      },
    };
    const bridge = new RealtimeBridge(adapter, reasoner);
    const session = new VoiceAgentSession({
      plugins: { realtime: {} },
      endpointingOwner: "timer",
      minInterruptionMs: 0,
    });
    session.registerPlugin("realtime", bridge);

    const turnChanges: TurnChangePacket[] = [];
    session.bus.on("turn.change", (pkt) => { turnChanges.push(pkt as TurnChangePacket); });

    await session.start();

    adapter.emit({ type: "response_started" });
    await waitForCondition(() => turnChanges.length >= 1);
    adapter.emit({
      type: "tool_call",
      toolId: "call_still_running",
      toolName: "consult_knowledge",
      args: { query: "late add policy" },
    });
    await waitForCondition(() => delegateSignal !== undefined);

    adapter.emit({ type: "tool_call_cancelled", toolIds: ["some_other_unrelated_call"] });

    // No signal to wait on for an absence — give the (already-queued) event a real tick to
    // land, matching the pump's actual scheduling, then assert the in-flight turn is untouched.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(delegateSignal!.aborted).toBe(false);

    await session.close();
  });

  // ── Half-cascade C1: textOnly routing ────────────────────────────────────
  // In text-only mode the bridge streams assistant transcript into the cascade
  // llm.delta → segmenter → tts.text path. The TTS plugin owns tts.end.

  it("textOnly: streams assistant transcript deltas as llm.delta in order as they arrive", async () => {
    const adapter = new FakeRealtimeAdapter();
    const bridge = new RealtimeBridge(adapter, undefined, "consult_knowledge", { textOnly: true });
    const bus = new PipelineBusImpl();
    buses.push(bus);
    const deltas: LlmDeltaPacket[] = [];
    bus.on("llm.delta", (pkt) => { deltas.push(pkt as LlmDeltaPacket); });

    const started = bus.start();
    await bridge.initialize(bus, {});

    adapter.emit({ type: "response_started" });
    adapter.emit({ type: "transcript", role: "assistant", text: "The capital", final: false });
    adapter.emit({ type: "transcript", role: "assistant", text: " of France", final: false });
    adapter.emit({ type: "transcript", role: "assistant", text: " is Paris.", final: false });

    await waitForCondition(() => deltas.length === 3);
    expect(deltas.map((d) => d.text)).toEqual(["The capital", " of France", " is Paris."]);

    await bridge.close();
    bus.stop();
    await started;
  });

  it("textOnly: final assistant transcript pushes llm.done and no full-text llm.delta", async () => {
    const adapter = new FakeRealtimeAdapter();
    const bridge = new RealtimeBridge(adapter, undefined, "consult_knowledge", { textOnly: true });
    const bus = new PipelineBusImpl();
    buses.push(bus);
    const deltas: LlmDeltaPacket[] = [];
    const dones: LlmResponseDonePacket[] = [];
    bus.on("llm.delta", (pkt) => { deltas.push(pkt as LlmDeltaPacket); });
    bus.on("llm.done", (pkt) => { dones.push(pkt as LlmResponseDonePacket); });

    const started = bus.start();
    await bridge.initialize(bus, {});

    adapter.emit({ type: "response_started" });
    adapter.emit({ type: "transcript", role: "assistant", text: "Hello ", final: false });
    adapter.emit({ type: "transcript", role: "assistant", text: "world.", final: false });
    // C0 adapter output_text.done carries the FULL accumulated text — must not re-emit as delta.
    adapter.emit({ type: "transcript", role: "assistant", text: "Hello world.", final: true });

    await waitForCondition(() => dones.length === 1);
    expect(deltas.map((d) => d.text)).toEqual(["Hello ", "world."]);
    expect(dones).toHaveLength(1);
    expect(dones[0]!.text).toBe("Hello world.");
    // No extra full-text llm.delta for the final event.
    expect(deltas.some((d) => d.text === "Hello world.")).toBe(false);

    await bridge.close();
    bus.stop();
    await started;
  });

  it("textOnly: provider audio events push no tts.audio", async () => {
    const adapter = new FakeRealtimeAdapter();
    const bridge = new RealtimeBridge(adapter, undefined, "consult_knowledge", { textOnly: true });
    const bus = new PipelineBusImpl();
    buses.push(bus);
    const audio: TextToSpeechAudioPacket[] = [];
    bus.on("tts.audio", (pkt) => { audio.push(pkt as TextToSpeechAudioPacket); });

    const started = bus.start();
    await bridge.initialize(bus, {});

    adapter.emit({ type: "response_started" });
    adapter.emit({
      type: "audio",
      pcm16: frameSizedPcm24k(),
      sampleRateHz: 24_000,
    });
    adapter.emit({ type: "response_done" });

    await waitForCondition(() => true); // allow pump to drain
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(audio).toHaveLength(0);

    await bridge.close();
    bus.stop();
    await started;
  });

  it("textOnly: onResponseDone does not re-emit assistant llm.delta and does not emit tts.end", async () => {
    const adapter = new FakeRealtimeAdapter();
    const bridge = new RealtimeBridge(adapter, undefined, "consult_knowledge", { textOnly: true });
    const bus = new PipelineBusImpl();
    buses.push(bus);
    const deltas: LlmDeltaPacket[] = [];
    const dones: LlmResponseDonePacket[] = [];
    const ends: TextToSpeechEndPacket[] = [];
    const turnCompletes: EndOfSpeechPacket[] = [];
    bus.on("llm.delta", (pkt) => { deltas.push(pkt as LlmDeltaPacket); });
    bus.on("llm.done", (pkt) => { dones.push(pkt as LlmResponseDonePacket); });
    bus.on("tts.end", (pkt) => { ends.push(pkt as TextToSpeechEndPacket); });
    bus.on("eos.turn_complete", (pkt) => { turnCompletes.push(pkt as EndOfSpeechPacket); });

    const started = bus.start();
    await bridge.initialize(bus, {});

    adapter.emit({ type: "response_started" });
    adapter.emit({ type: "transcript", role: "assistant", text: "Streamed.", final: false });
    adapter.emit({ type: "transcript", role: "assistant", text: "Streamed.", final: true });
    await waitForCondition(() => dones.length === 1);
    const deltasBeforeDone = deltas.length;

    adapter.emit({ type: "response_done" });
    await waitForCondition(() => turnCompletes.length === 1);

    // No duplicate display-only llm.delta/llm.done from onResponseDone.
    expect(deltas).toHaveLength(deltasBeforeDone);
    expect(dones).toHaveLength(1);
    // TTS plugin owns tts.end in text-only mode — bridge must not force it.
    expect(ends).toHaveLength(0);
    expect(turnCompletes).toHaveLength(1);

    await bridge.close();
    bus.stop();
    await started;
  });
});
