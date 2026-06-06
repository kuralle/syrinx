// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import type { ManagedSocket, SocketData, SocketFactory } from "@kuralle-syrinx/ws";

import type { RealtimeEvent } from "./realtime-adapter.js";
import { base64ToBytes, bytesToBase64, fromOpenAIRealtime } from "./from-openai-realtime.js";

interface MockSocketHarness {
  readonly factory: SocketFactory;
  readonly sent: string[];
  inject(msg: Record<string, unknown>): void;
}

function createMockSocketHarness(): MockSocketHarness {
  const sent: string[] = [];
  let messageHandler: ((data: SocketData, isBinary: boolean) => void) | null = null;

  const socket: ManagedSocket = {
    get isOpen() {
      return true;
    },
    send: (data: SocketData) => {
      sent.push(typeof data === "string" ? data : "");
    },
    keepAlivePing: () => {},
    verify: async () => true,
    dispose: () => {},
    onOpen: (handler) => {
      queueMicrotask(() => handler());
    },
    onMessage: (handler) => {
      messageHandler = handler;
    },
    onClose: () => {},
    onError: () => {},
  };

  return {
    factory: () => socket,
    sent,
    inject: (msg) => messageHandler?.(JSON.stringify(msg), false),
  };
}

async function collectEvents(
  events: AsyncIterable<RealtimeEvent>,
  max = 8,
): Promise<RealtimeEvent[]> {
  const out: RealtimeEvent[] = [];
  for await (const event of events) {
    out.push(event);
    if (out.length >= max) break;
  }
  return out;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

describe("fromOpenAIRealtime", () => {
  it("emits exact client events for open, audio, cancel, and tool result", async () => {
    const mock = createMockSocketHarness();
    const adapter = fromOpenAIRealtime({
      apiKey: "test-key",
      socketFactory: mock.factory,
      url: () => "wss://example.test/realtime?model=gpt-realtime-2",
      tools: [
        {
          name: "consult_knowledge",
          description: "Answer knowledge questions.",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        },
      ],
    });

    const openTask = adapter.open(new AbortController().signal);
    await waitFor(() => mock.sent.length > 0);
    mock.inject({ type: "session.updated" });
    await openTask;

    const sessionUpdate = JSON.parse(mock.sent[0]!) as Record<string, unknown>;
    expect(sessionUpdate).toEqual({
      type: "session.update",
      session: {
        type: "realtime",
        model: "gpt-realtime-2",
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            turn_detection: { type: "semantic_vad" },
          },
          output: {
            format: { type: "audio/pcm", rate: 24000 },
            voice: "marin",
          },
        },
        tools: [
          {
            type: "function",
            name: "consult_knowledge",
            description: "Answer knowledge questions.",
            parameters: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
        ],
        tool_choice: "auto",
      },
    });

    const pcm = new Uint8Array([0, 1, 2, 3]);
    adapter.sendAudio(pcm);
    expect(JSON.parse(mock.sent[1]!)).toEqual({
      type: "input_audio_buffer.append",
      audio: bytesToBase64(pcm),
    });

    mock.inject({ type: "response.created" });
    mock.inject({
      type: "response.output_item.added",
      item: { type: "message", id: "item_assistant_1" },
    });
    adapter.cancelResponse(420);
    expect(JSON.parse(mock.sent[2]!)).toEqual({ type: "response.cancel" });
    expect(JSON.parse(mock.sent[3]!)).toEqual({
      type: "conversation.item.truncate",
      item_id: "item_assistant_1",
      content_index: 0,
      audio_end_ms: 420,
    });

    adapter.injectToolResult("call_abc", "Late Add Petition required.");
    expect(JSON.parse(mock.sent[4]!)).toEqual({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: "call_abc",
        output: "Late Add Petition required.",
      },
    });
    expect(mock.sent).toHaveLength(5);

    mock.inject({ type: "response.done", response: {} });
    expect(JSON.parse(mock.sent[5]!)).toEqual({ type: "response.create" });
  });

  it("normalizes provider server events into RealtimeEvent", async () => {
    const mock = createMockSocketHarness();
    const adapter = fromOpenAIRealtime({
      apiKey: "test-key",
      socketFactory: mock.factory,
      url: () => "wss://example.test/realtime?model=gpt-realtime-2",
    });

    const eventsTask = collectEvents(adapter.events, 8);
    const openTask = adapter.open(new AbortController().signal);
    await waitFor(() => mock.sent.length > 0);
    mock.inject({ type: "session.updated" });
    await openTask;

    const audioBytes = new Uint8Array([9, 10, 11, 12]);
    mock.inject({
      type: "response.created",
    });
    mock.inject({
      type: "response.output_audio.delta",
      delta: bytesToBase64(audioBytes),
    });
    mock.inject({ type: "input_audio_buffer.speech_started" });
    mock.inject({
      type: "response.output_audio_transcript.delta",
      delta: "Let me ",
    });
    mock.inject({
      type: "response.output_audio_transcript.done",
      transcript: "Let me check that.",
    });
    mock.inject({
      type: "response.done",
      response: {
        output: [
          {
            type: "function_call",
            call_id: "call_123",
            name: "consult_knowledge",
            arguments: JSON.stringify({ query: "late add biology" }),
          },
        ],
      },
    });
    mock.inject({
      type: "error",
      error: { message: "rate limited", code: "rate_limit_exceeded" },
    });

    const events = await eventsTask;
    expect(events.slice(0, 7)).toEqual([
      { type: "response_started" },
      { type: "audio", pcm16: audioBytes, sampleRateHz: 24000 },
      { type: "speech_started" },
      { type: "transcript", role: "assistant", text: "Let me ", final: false },
      { type: "transcript", role: "assistant", text: "Let me check that.", final: true },
      {
        type: "tool_call",
        toolId: "call_123",
        toolName: "consult_knowledge",
        args: { query: "late add biology" },
      },
      { type: "response_done" },
    ]);
    expect(events[7]).toMatchObject({ type: "error", recoverable: true });
    if (events[7]?.type === "error") {
      expect(events[7].cause.message).toBe("rate limited");
    }
  });

  it("exposes gpt-realtime-2 capability flags", () => {
    const mock = createMockSocketHarness();
    const adapter = fromOpenAIRealtime({
      apiKey: "test-key",
      socketFactory: mock.factory,
    });
    expect(adapter.caps).toEqual({
      inputSampleRateHz: 24000,
      outputSampleRateHz: 24000,
      supportsConcurrentToolAudio: true,
      supportsTruncate: true,
    });
  });

  it("R-04: base64 encode/decode works without Buffer or process", async () => {
    const savedBuffer = (globalThis as { Buffer?: unknown }).Buffer;
    const savedProcess = (globalThis as { process?: unknown }).process;
    delete (globalThis as { Buffer?: unknown }).Buffer;
    delete (globalThis as { process?: unknown }).process;

    try {
      const pcm = new Uint8Array([0, 1, 2, 3, 255, 128]);
      const encoded = bytesToBase64(pcm);
      expect(base64ToBytes(encoded)).toEqual(pcm);

      const mock = createMockSocketHarness();
      const adapter = fromOpenAIRealtime({
        apiKey: "test-key",
        socketFactory: mock.factory,
        url: () => "wss://example.test/realtime?model=gpt-realtime-2",
      });

      const openTask = adapter.open(new AbortController().signal);
      await waitFor(() => mock.sent.length > 0);
      mock.inject({ type: "session.updated" });
      await openTask;

      adapter.sendAudio(pcm);
      const sent = JSON.parse(mock.sent[1]!) as { audio: string };
      expect(sent.audio).toBe(encoded);
    } finally {
      if (savedBuffer !== undefined) (globalThis as { Buffer?: unknown }).Buffer = savedBuffer;
      if (savedProcess !== undefined) (globalThis as { process?: unknown }).process = savedProcess;
    }
  });

  it("R-06: forwards optional session config into session.update", async () => {
    const mock = createMockSocketHarness();
    const adapter = fromOpenAIRealtime({
      apiKey: "test-key",
      socketFactory: mock.factory,
      url: () => "wss://example.test/realtime?model=gpt-realtime-2",
      instructions: "You are a helpful assistant.",
      modalities: ["audio", "text"],
      temperature: 0.7,
      inputTranscription: { model: "whisper-1" },
      toolChoice: "required",
      inputRateHz: 16000,
      outputRateHz: 16000,
    });

    const openTask = adapter.open(new AbortController().signal);
    await waitFor(() => mock.sent.length > 0);
    mock.inject({ type: "session.updated" });
    await openTask;

    expect(JSON.parse(mock.sent[0]!)).toEqual({
      type: "session.update",
      session: {
        type: "realtime",
        model: "gpt-realtime-2",
        output_modalities: ["audio", "text"],
        instructions: "You are a helpful assistant.",
        temperature: 0.7,
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 16000 },
            turn_detection: { type: "semantic_vad" },
            transcription: { model: "whisper-1" },
          },
          output: {
            format: { type: "audio/pcm", rate: 16000 },
            voice: "marin",
          },
        },
        tools: [],
        tool_choice: "required",
      },
    });
    expect(adapter.caps.inputSampleRateHz).toBe(16000);
    expect(adapter.caps.outputSampleRateHz).toBe(16000);
  });

  it("R-10: skips response.create when requiresResponseCreateAfterToolOutput is false", async () => {
    const mock = createMockSocketHarness();
    const adapter = fromOpenAIRealtime({
      apiKey: "test-key",
      socketFactory: mock.factory,
      url: () => "wss://example.test/realtime?model=gpt-realtime-2",
      requiresResponseCreateAfterToolOutput: false,
    });

    const openTask = adapter.open(new AbortController().signal);
    await waitFor(() => mock.sent.length > 0);
    mock.inject({ type: "session.updated" });
    await openTask;

    adapter.injectToolResult("call_xyz", "done");
    expect(mock.sent).toHaveLength(2);
    expect(JSON.parse(mock.sent[1]!)).toEqual({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: "call_xyz",
        output: "done",
      },
    });
  });

  it("B1: does not send response.create while response is active (cancel-in-flight interleaving)", async () => {
    const mock = createMockSocketHarness();
    const adapter = fromOpenAIRealtime({
      apiKey: "test-key",
      socketFactory: mock.factory,
      url: () => "wss://example.test/realtime?model=gpt-realtime-2",
    });

    const openTask = adapter.open(new AbortController().signal);
    await waitFor(() => mock.sent.length > 0);
    mock.inject({ type: "session.updated" });
    await openTask;

    mock.inject({ type: "response.created" });
    mock.inject({
      type: "response.output_item.added",
      item: { type: "message", id: "item_assistant_1" },
    });

    adapter.cancelResponse(420);
    expect(JSON.parse(mock.sent[1]!)).toEqual({ type: "response.cancel" });
    expect(JSON.parse(mock.sent[2]!)).toEqual({
      type: "conversation.item.truncate",
      item_id: "item_assistant_1",
      content_index: 0,
      audio_end_ms: 420,
    });

    adapter.injectToolResult("call_abc", "Late Add Petition required.");
    const typesAfterInject = mock.sent.map(
      (raw) => (JSON.parse(raw) as Record<string, unknown>)["type"],
    );
    expect(typesAfterInject).toContain("conversation.item.create");
    expect(typesAfterInject).not.toContain("response.create");

    mock.inject({ type: "response.done", response: {} });
    const typesAfterDone = mock.sent.map(
      (raw) => (JSON.parse(raw) as Record<string, unknown>)["type"],
    );
    expect(typesAfterDone.filter((t) => t === "response.create")).toHaveLength(1);
    expect(JSON.parse(mock.sent[mock.sent.length - 1]!)).toEqual({ type: "response.create" });
  });

  it("B1: does not send response.create while response is active (direct inject without cancel)", async () => {
    const mock = createMockSocketHarness();
    const adapter = fromOpenAIRealtime({
      apiKey: "test-key",
      socketFactory: mock.factory,
      url: () => "wss://example.test/realtime?model=gpt-realtime-2",
    });

    const openTask = adapter.open(new AbortController().signal);
    await waitFor(() => mock.sent.length > 0);
    mock.inject({ type: "session.updated" });
    await openTask;

    mock.inject({ type: "response.created" });

    adapter.injectToolResult("call_xyz", "inline result");
    const typesAfterInject = mock.sent.map(
      (raw) => (JSON.parse(raw) as Record<string, unknown>)["type"],
    );
    expect(typesAfterInject).toContain("conversation.item.create");
    expect(typesAfterInject).not.toContain("response.create");

    mock.inject({ type: "response.done", response: {} });
    expect(
      mock.sent.map((raw) => (JSON.parse(raw) as Record<string, unknown>)["type"]),
    ).toContain("response.create");
  });

  it("R-11: does not truncate stale item when new response is canceled before output_item.added", async () => {
    const mock = createMockSocketHarness();
    const adapter = fromOpenAIRealtime({
      apiKey: "test-key",
      socketFactory: mock.factory,
      url: () => "wss://example.test/realtime?model=gpt-realtime-2",
    });

    const openTask = adapter.open(new AbortController().signal);
    await waitFor(() => mock.sent.length > 0);
    mock.inject({ type: "session.updated" });
    await openTask;

    mock.inject({ type: "response.created" });
    mock.inject({
      type: "response.output_item.added",
      item: { type: "message", id: "item_old" },
    });
    mock.inject({ type: "response.done" });

    mock.inject({ type: "response.created" });
    adapter.cancelResponse(100);

    const truncateMessages = mock.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((msg) => msg["type"] === "conversation.item.truncate");
    expect(truncateMessages).toHaveLength(0);
  });
});
