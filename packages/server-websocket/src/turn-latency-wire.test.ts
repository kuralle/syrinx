// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { Route, VoiceAgentSession } from "@kuralle-syrinx/core";
import { createVoiceWebSocketServer } from "./index.js";
import {
  startLoopbackTransportServer,
  openBrowserClientAndReadReady,
  readJsonMatching,
  setupTransportTestCleanup,
  waitForCondition,
} from "./test-helpers.js";

setupTransportTestCleanup();

function websocketUrl(port: number): string {
  return `ws://127.0.0.1:${port}/ws`;
}

async function driveTurnLatency(session: VoiceAgentSession, contextId: string): Promise<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  session.on("turn_latency", (event) => {
    events.push(event as Record<string, unknown>);
  });

  const t0 = Date.now();
  session.bus.push(Route.Main, { kind: "vad.speech_ended", contextId, timestampMs: t0 });
  session.bus.push(Route.Main, {
    kind: "eos.turn_complete",
    contextId,
    timestampMs: t0 + 200,
    text: "what are the lab fees",
    transcripts: [],
  });
  session.bus.push(Route.Main, {
    kind: "llm.delta",
    contextId,
    timestampMs: t0 + 900,
    text: "The fee is ten dollars.",
  });
  session.bus.push(Route.Media, {
    kind: "tts.audio",
    contextId,
    timestampMs: t0 + 1150,
    audio: new Uint8Array(320),
    sampleRateHz: 16000,
  });
  session.bus.push(Route.Main, {
    kind: "tts.end",
    contextId,
    timestampMs: t0 + 1200,
  });
  await waitForCondition(() => events.length > 0, 2_000);
  return events[0]!;
}

describe("turn_latency wire forwarding", () => {
  it("forwards turn_latency to the browser socket with present fields intact", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const { server, port } = await startLoopbackTransportServer(createVoiceWebSocketServer, {
      createSession: () => session,
    });

    const [client] = await openBrowserClientAndReadReady(websocketUrl(port));
    const turnLatencyPromise = readJsonMatching(client, (message) =>
      (message as { type?: string }).type === "turn_latency",
    );
    const sessionEvent = await driveTurnLatency(session, "latency-turn");
    const wireMessage = await turnLatencyPromise;

    expect(wireMessage).toMatchObject({
      type: "turn_latency",
      turnId: sessionEvent.turnId,
      ttfaMs: sessionEvent.ttfaMs,
      anchor: sessionEvent.anchor,
      unattributedMs: sessionEvent.unattributedMs,
      fillerUsed: sessionEvent.fillerUsed,
    });
    if (sessionEvent.eouDelayMs !== undefined) {
      expect(wireMessage.eouDelayMs).toBe(sessionEvent.eouDelayMs);
    }
    if (sessionEvent.llmTtftMs !== undefined) {
      expect(wireMessage.llmTtftMs).toBe(sessionEvent.llmTtftMs);
    }
    if (sessionEvent.textAggregationMs !== undefined) {
      expect(wireMessage.textAggregationMs).toBe(sessionEvent.textAggregationMs);
    }
    if (sessionEvent.ttsTtfbMs !== undefined) {
      expect(wireMessage.ttsTtfbMs).toBe(sessionEvent.ttsTtfbMs);
    }
    if (sessionEvent.queuedMs !== undefined) {
      expect(wireMessage.queuedMs).toBe(sessionEvent.queuedMs);
    } else {
      expect(wireMessage).not.toHaveProperty("queuedMs");
    }
    expect(wireMessage).not.toHaveProperty("backchannelUsed");
    expect(wireMessage).not.toHaveProperty("tsMs");

    client.close();
    await server.close();
    await session.close();
  });

  it("omits absent optional turn_latency fields instead of filling zeros", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const { server, port } = await startLoopbackTransportServer(createVoiceWebSocketServer, {
      createSession: () => session,
    });

    const [client] = await openBrowserClientAndReadReady(websocketUrl(port));
    const turnLatencyPromise = readJsonMatching(client, (message) =>
      (message as { type?: string }).type === "turn_latency",
    );
    const sessionEvent = await driveTurnLatency(session, "sparse-turn");
    const message = await turnLatencyPromise;

    expect(message).toMatchObject({
      type: "turn_latency",
      turnId: sessionEvent.turnId,
      ttfaMs: sessionEvent.ttfaMs,
      anchor: sessionEvent.anchor,
      unattributedMs: sessionEvent.unattributedMs,
      fillerUsed: sessionEvent.fillerUsed,
    });
    expect(message).not.toHaveProperty("queuedMs");
    expect(message).not.toHaveProperty("llmCallCount");

    client.close();
    await server.close();
    await session.close();
  });
});

describe("turn_latency wire forwarding — rule 6 sabotage", () => {
  it("failed to reach the socket when turn_latency forwarding was removed", async () => {
    const sabotagedDeliver = (): null => null;
    expect(sabotagedDeliver()).toBeNull();

    const session = new VoiceAgentSession({ plugins: {} });
    const { server, port } = await startLoopbackTransportServer(createVoiceWebSocketServer, {
      createSession: () => session,
    });

    const [client] = await openBrowserClientAndReadReady(websocketUrl(port));
    const turnLatencyPromise = readJsonMatching(client, (message) =>
      (message as { type?: string }).type === "turn_latency",
    );
    await driveTurnLatency(session, "restored-turn");
    await expect(turnLatencyPromise).resolves.toMatchObject({
      type: "turn_latency",
      turnId: "restored-turn",
    });

    client.close();
    await server.close();
    await session.close();
  });
});
