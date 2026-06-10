// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import type { ManagedSocket, SocketData, SocketFactory } from "@kuralle-syrinx/ws";

import type { RealtimeEvent } from "@kuralle-syrinx/realtime";

import { bytesToBase64, fromGrokRealtime } from "./from-grok-realtime.js";

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

describe("fromGrokRealtime", () => {
  it("sends Grok session.update and client control messages", async () => {
    const mock = createMockSocketHarness();
    const adapter = fromGrokRealtime({
      apiKey: "test-key",
      socketFactory: mock.factory,
      url: () => "wss://example.test/realtime?model=grok-voice-latest",
      voice: "eve",
      instructions: "Be concise.",
      turnDetection: { type: "server_vad" },
      tools: [
        {
          name: "lookup",
          description: "Look up facts.",
          parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
        },
      ],
    });

    const openTask = adapter.open(new AbortController().signal);
    await waitFor(() => mock.sent.length > 0);
    mock.inject({ type: "session.updated" });
    await openTask;

    expect(JSON.parse(mock.sent[0]!)).toEqual({
      type: "session.update",
      session: {
        voice: "eve",
        instructions: "Be concise.",
        turn_detection: { type: "server_vad" },
        tools: [
          {
            type: "function",
            name: "lookup",
            description: "Look up facts.",
            parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
          },
        ],
        audio: {
          input: { format: { type: "audio/pcm", rate: 24000 } },
          output: { format: { type: "audio/pcm", rate: 24000 }, voice: "eve" },
        },
      },
    });

    const pcm = new Uint8Array([0, 1, 2, 3]);
    adapter.sendAudio(pcm);
    expect(JSON.parse(mock.sent[1]!)).toEqual({
      type: "input_audio_buffer.append",
      audio: bytesToBase64(pcm),
    });

    mock.inject({ type: "response.created" });
    adapter.cancelResponse(420);
    expect(JSON.parse(mock.sent[2]!)).toEqual({ type: "response.cancel" });
    expect(
      mock.sent
        .map((raw) => JSON.parse(raw) as Record<string, unknown>)
        .some((msg) => msg["type"] === "conversation.item.truncate"),
    ).toBe(false);

    adapter.injectToolResult("call_abc", "result text");
    expect(JSON.parse(mock.sent[3]!)).toEqual({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: "call_abc",
        output: "result text",
      },
    });
    expect(mock.sent).toHaveLength(4);

    mock.inject({ type: "response.done", response: {} });
    expect(JSON.parse(mock.sent[4]!)).toEqual({ type: "response.create" });
  });

  it("normalizes provider server events into RealtimeEvent", async () => {
    const mock = createMockSocketHarness();
    const adapter = fromGrokRealtime({
      apiKey: "test-key",
      socketFactory: mock.factory,
      url: () => "wss://example.test/realtime?model=grok-voice-latest",
    });

    const eventsTask = collectEvents(adapter.events, 7);
    const openTask = adapter.open(new AbortController().signal);
    await waitFor(() => mock.sent.length > 0);
    mock.inject({ type: "session.updated" });
    await openTask;

    const audioBytes = new Uint8Array([9, 10, 11, 12]);
    mock.inject({ type: "response.created" });
    mock.inject({ type: "response.output_audio.delta", delta: bytesToBase64(audioBytes) });
    mock.inject({
      type: "conversation.item.input_audio_transcription.updated",
      transcript: "hello there",
    });
    mock.inject({ type: "response.output_audio_transcript.delta", delta: "Sure, " });
    mock.inject({
      type: "response.output_audio_transcript.done",
      transcript: "Sure, I can help.",
    });
    mock.inject({
      type: "response.done",
      response: {
        output: [
          {
            type: "function_call",
            call_id: "call_123",
            name: "lookup",
            arguments: JSON.stringify({ q: "hours" }),
          },
        ],
      },
    });

    const events = await eventsTask;
    expect(events.slice(0, 6)).toEqual([
      { type: "response_started" },
      { type: "audio", pcm16: audioBytes, sampleRateHz: 24000 },
      { type: "transcript", role: "user", text: "hello there", final: true },
      { type: "transcript", role: "assistant", text: "Sure, ", final: false },
      { type: "transcript", role: "assistant", text: "Sure, I can help.", final: true },
      {
        type: "tool_call",
        toolId: "call_123",
        toolName: "lookup",
        args: { q: "hours" },
      },
    ]);
    expect(events[6]).toEqual({ type: "response_done" });
  });

  it("B1: does not send response.create while response is active (cancel-in-flight, no truncate)", async () => {
    const mock = createMockSocketHarness();
    const adapter = fromGrokRealtime({
      apiKey: "test-key",
      socketFactory: mock.factory,
      url: () => "wss://example.test/realtime?model=grok-voice-latest",
    });

    const openTask = adapter.open(new AbortController().signal);
    await waitFor(() => mock.sent.length > 0);
    mock.inject({ type: "session.updated" });
    await openTask;

    mock.inject({ type: "response.created" });
    adapter.cancelResponse(420);
    expect(JSON.parse(mock.sent[1]!)).toEqual({ type: "response.cancel" });
    expect(
      mock.sent
        .map((raw) => JSON.parse(raw) as Record<string, unknown>)
        .some((msg) => msg["type"] === "conversation.item.truncate"),
    ).toBe(false);

    adapter.injectToolResult("call_abc", "result text");
    const typesAfterInject = mock.sent.map(
      (raw) => (JSON.parse(raw) as Record<string, unknown>)["type"],
    );
    expect(typesAfterInject).toContain("conversation.item.create");
    expect(typesAfterInject).not.toContain("response.create");

    mock.inject({ type: "response.done", response: {} });
    expect(JSON.parse(mock.sent[mock.sent.length - 1]!)).toEqual({ type: "response.create" });
  });

  it("B1: does not send response.create while response is active (direct inject without cancel)", async () => {
    const mock = createMockSocketHarness();
    const adapter = fromGrokRealtime({
      apiKey: "test-key",
      socketFactory: mock.factory,
      url: () => "wss://example.test/realtime?model=grok-voice-latest",
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

  it("exposes Grok capability flags", () => {
    const mock = createMockSocketHarness();
    const adapter = fromGrokRealtime({
      apiKey: "test-key",
      socketFactory: mock.factory,
      inputRateHz: 16000,
      outputRateHz: 16000,
    });
    expect(adapter.caps).toEqual({
      inputSampleRateHz: 16000,
      outputSampleRateHz: 16000,
      supportsConcurrentToolAudio: false,
      supportsTruncate: false,
      emitsServerSpeechStarted: false,
    });
  });
});
