// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import type { ManagedSocket, SocketData, SocketFactory } from "@kuralle-syrinx/ws";

import { createOpenAiCompatibleRealtimeAdapter } from "./openai-compatible-realtime.js";
import type { RealtimeEvent } from "./realtime-adapter.js";

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

function createAdapter(mock: MockSocketHarness) {
  return createOpenAiCompatibleRealtimeAdapter({
    apiKey: "test-key",
    socketFactory: mock.factory,
    defaultModel: "gpt-realtime-2",
    url: () => "wss://example.test/realtime?model=gpt-realtime-2",
    caps: {
      inputSampleRateHz: 24_000,
      outputSampleRateHz: 24_000,
      supportsConcurrentToolAudio: true,
      supportsTruncate: true,
      emitsServerSpeechStarted: true,
      supportsTextOnlyModality: true,
    },
    buildSessionUpdate: () => ({
      type: "realtime",
      model: "gpt-realtime-2",
      output_modalities: ["text"],
    }),
    supportsTruncate: true,
    defaultErrorMessage: "OpenAI Realtime error",
  });
}

describe("createOpenAiCompatibleRealtimeAdapter text-only output", () => {
  it("surfaces response.output_text.delta as assistant transcript (final=false)", async () => {
    const mock = createMockSocketHarness();
    const adapter = createAdapter(mock);

    const eventsTask = collectEvents(adapter.events, 2);
    const openTask = adapter.open(new AbortController().signal);
    await waitFor(() => mock.sent.length > 0);
    mock.inject({ type: "session.updated" });
    await openTask;

    mock.inject({ type: "response.created" });
    mock.inject({
      type: "response.output_text.delta",
      delta: "Let me ",
    });

    const events = await eventsTask;
    expect(events).toEqual([
      { type: "response_started" },
      { type: "transcript", role: "assistant", text: "Let me ", final: false },
    ]);
  });

  it("surfaces response.output_text.done as final assistant transcript with accumulated text", async () => {
    const mock = createMockSocketHarness();
    const adapter = createAdapter(mock);

    const eventsTask = collectEvents(adapter.events, 3);
    const openTask = adapter.open(new AbortController().signal);
    await waitFor(() => mock.sent.length > 0);
    mock.inject({ type: "session.updated" });
    await openTask;

    mock.inject({ type: "response.created" });
    mock.inject({
      type: "response.output_text.delta",
      delta: "Let me ",
    });
    mock.inject({
      type: "response.output_text.done",
      text: "Let me check that.",
    });

    const events = await eventsTask;
    expect(events).toEqual([
      { type: "response_started" },
      { type: "transcript", role: "assistant", text: "Let me ", final: false },
      { type: "transcript", role: "assistant", text: "Let me check that.", final: true },
    ]);
  });

  it("uses assistantTranscript when response.output_text.done omits text", async () => {
    const mock = createMockSocketHarness();
    const adapter = createAdapter(mock);

    const eventsTask = collectEvents(adapter.events, 3);
    const openTask = adapter.open(new AbortController().signal);
    await waitFor(() => mock.sent.length > 0);
    mock.inject({ type: "session.updated" });
    await openTask;

    mock.inject({ type: "response.created" });
    mock.inject({
      type: "response.output_text.delta",
      delta: "Hello",
    });
    mock.inject({
      type: "response.output_text.done",
    });

    const events = await eventsTask;
    expect(events).toEqual([
      { type: "response_started" },
      { type: "transcript", role: "assistant", text: "Hello", final: false },
      { type: "transcript", role: "assistant", text: "Hello", final: true },
    ]);
  });
});
