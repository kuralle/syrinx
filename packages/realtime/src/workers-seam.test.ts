// SPDX-License-Identifier: MIT
//
// Proves fromOpenAIRealtime composes with createWorkersSocket: fetch-upgrade uses
// https:// (not wss://), carries Authorization: Bearer, accept()s the socket,
// and round-trips provider audio into RealtimeEvent.

import { afterEach, describe, expect, it } from "vitest";

import { createWorkersSocket } from "@kuralle-syrinx/ws/workers";
import type { WebSocketEventLike, WebSocketLike } from "@kuralle-syrinx/ws/web";

import { bytesToBase64, fromOpenAIRealtime } from "./from-openai-realtime.js";
import type { RealtimeEvent } from "./realtime-adapter.js";

interface MockWorkerdHarness {
  readonly fetchCalls: Array<{ url: string; headers: Record<string, string> }>;
  readonly sent: string[];
  readonly acceptCalled: boolean;
  inject(msg: Record<string, unknown>): void;
}

function installMockWorkerdFetch(): MockWorkerdHarness {
  const fetchCalls: Array<{ url: string; headers: Record<string, string> }> = [];
  const sent: string[] = [];
  let acceptCalled = false;
  const messageListeners = new Set<(event: WebSocketEventLike) => void>();

  const mockWs: WebSocketLike & { accept(): void } = {
    readyState: 1,
    binaryType: "arraybuffer",
    accept: () => {
      acceptCalled = true;
    },
    send: (data) => {
      if (typeof data === "string") sent.push(data);
    },
    close: () => {},
    addEventListener: (type, listener) => {
      if (type === "message") messageListeners.add(listener);
    },
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    fetchCalls.push({ url, headers });
    return { status: 101, webSocket: mockWs } as unknown as Response;
  };

  return {
    fetchCalls,
    sent,
    get acceptCalled() {
      return acceptCalled;
    },
    inject: (msg) => {
      const payload = JSON.stringify(msg);
      for (const listener of messageListeners) listener({ data: payload });
    },
  };
}

let restoreFetch: (() => void) | null = null;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
});

async function collectEvents(
  events: AsyncIterable<RealtimeEvent>,
  max = 4,
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

describe("Workers seam", () => {
  it("opens via createWorkersSocket fetch-upgrade and round-trips audio events", async () => {
    const harness = installMockWorkerdFetch();
    const originalFetch = globalThis.fetch;
    restoreFetch = () => {
      globalThis.fetch = originalFetch;
    };

    const adapter = fromOpenAIRealtime({
      apiKey: "workers-test-key",
      socketFactory: createWorkersSocket,
      url: () => "wss://api.openai.com/v1/realtime?model=gpt-realtime-2",
    });

    const eventsTask = collectEvents(adapter.events, 2);
    const openTask = adapter.open(new AbortController().signal);

    await waitFor(() => harness.fetchCalls.length > 0);
    await waitFor(() => harness.sent.length > 0);

    expect(harness.fetchCalls[0]!.url).toBe(
      "https://api.openai.com/v1/realtime?model=gpt-realtime-2",
    );
    expect(harness.fetchCalls[0]!.url).not.toMatch(/^wss:\/\//);
    expect(harness.fetchCalls[0]!.headers).toMatchObject({
      Authorization: "Bearer workers-test-key",
      Upgrade: "websocket",
    });
    expect(harness.acceptCalled).toBe(true);
    expect(JSON.parse(harness.sent[0]!)["type"]).toBe("session.update");

    harness.inject({ type: "session.updated" });
    await openTask;

    const audioBytes = new Uint8Array([9, 10, 11, 12]);
    harness.inject({ type: "response.created" });
    harness.inject({
      type: "response.output_audio.delta",
      delta: bytesToBase64(audioBytes),
    });

    const events = await eventsTask;
    const audioEvent = events.find((e) => e.type === "audio");
    expect(audioEvent).toEqual({
      type: "audio",
      pcm16: audioBytes,
      sampleRateHz: 24_000,
    });

    await adapter.close();
  });
});
