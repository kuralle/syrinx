// SPDX-License-Identifier: MIT

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Route, VoiceAgentSession } from "@asyncdot/voice";
import { pcm16SamplesToBytes } from "@asyncdot/voice/audio";
import { wireTelephonyOutboundPipeline } from "./outbound-playout-pipeline.js";

function createMockSocket(): WebSocket {
  const emitter = new EventEmitter();
  let readyState: number = WebSocket.OPEN;
  return {
    get readyState() {
      return readyState;
    },
    close: () => {
      readyState = WebSocket.CLOSED;
      emitter.emit("close");
    },
    terminate: () => {
      readyState = WebSocket.CLOSED;
      emitter.emit("close");
    },
    once: (event: string, handler: () => void) => {
      emitter.once(event, handler);
    },
    off: (event: string, handler: () => void) => {
      emitter.off(event, handler);
    },
  } as WebSocket;
}

function wireTestPipeline(socket: WebSocket): {
  readonly session: VoiceAgentSession;
  readonly handle: ReturnType<typeof wireTelephonyOutboundPipeline>;
  readonly disposers: Array<() => void>;
} {
  const session = new VoiceAgentSession({ plugins: {} });
  void session.start();
  const disposers: Array<() => void> = [];
  const handle = wireTelephonyOutboundPipeline({
    session,
    socket,
    disposers,
    outboundFrameDurationMs: 20,
    maxQueuedOutputAudioMs: 30_000,
    callbacks: {
      carrierLabel: "test",
      getContextId: () => "turn-drain",
      isActive: () => true,
      encodeFrames: (audio) => [{
        contextId: "turn-drain",
        send: () => true,
      }],
      onInterrupt: () => undefined,
      onDrain: () => undefined,
      onStop: () => undefined,
    },
  });
  return { session, handle, disposers };
}

function makeFrames(count: number): Array<{ contextId: string; send: () => boolean }> {
  return Array.from({ length: count }, () => ({
    contextId: "turn-drain",
    send: () => true,
  }));
}

describe("wireTelephonyOutboundPipeline.interrupt.tts", () => {
  it("clears playout and emits interrupt_onset_to_media_silent_ms", async () => {
    const socket = createMockSocket();
    const { session, disposers } = wireTestPipeline(socket);
    const mediaSilentMetrics: Array<{ name: string; value: string }> = [];

    session.bus.on("metric.conversation", (pkt) => {
      const metric = pkt as unknown as { name: string; value: string };
      if (metric.name === "test.interrupt_onset_to_media_silent_ms") mediaSilentMetrics.push(metric);
    });

    const onset = Date.now() - 25;
    session.bus.push(Route.Critical, {
      kind: "interrupt.tts",
      contextId: "turn-drain",
      timestampMs: onset,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mediaSilentMetrics).toEqual([
      expect.objectContaining({
        name: "test.interrupt_onset_to_media_silent_ms",
        value: expect.stringMatching(/^\d+$/),
      }),
    ]);
    expect(Number(mediaSilentMetrics[0]!.value)).toBeGreaterThanOrEqual(0);

    for (const dispose of disposers) dispose();
  });
});

describe("wireTelephonyOutboundPipeline overflow", () => {
  it("clears queued playout once at the 200ms cap without closing the socket", async () => {
    const socket = createMockSocket();
    const session = new VoiceAgentSession({ plugins: {} });
    await session.start();
    const disposers: Array<() => void> = [];
    const stops: string[] = [];
    const discardedMetrics: Array<{ name: string; value: string }> = [];
    let encodeCall = 0;

    wireTelephonyOutboundPipeline({
      session,
      socket,
      disposers,
      outboundFrameDurationMs: 20,
      maxQueuedOutputAudioMs: 200,
      callbacks: {
        carrierLabel: "test",
        getContextId: () => "turn-drain",
        isActive: () => true,
        encodeFrames: () => {
          encodeCall += 1;
          return makeFrames(encodeCall === 1 ? 10 : 2);
        },
        onInterrupt: () => undefined,
        onDrain: () => undefined,
        onStop: (reason) => {
          stops.push(reason);
        },
      },
    });
    session.bus.on("metric.conversation", (pkt) => {
      const metric = pkt as unknown as { name: string; value: string };
      if (metric.name === "test.overflow_playout_cleared_ms") {
        discardedMetrics.push(metric);
      }
    });

    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "turn-drain",
      timestampMs: Date.now(),
      audio: new Uint8Array([1, 2, 3, 4]),
      sampleRateHz: 8000,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "turn-drain",
      timestampMs: Date.now(),
      audio: new Uint8Array([5, 6, 7, 8]),
      sampleRateHz: 8000,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(stops).toEqual(["overflow"]);
    expect(discardedMetrics).toEqual([
      expect.objectContaining({
        name: "test.overflow_playout_cleared_ms",
        value: expect.stringMatching(/^\d+$/),
      }),
    ]);
    expect(Number(discardedMetrics[0]!.value)).toBeGreaterThan(0);
    expect(socket.readyState).toBe(WebSocket.OPEN);

    for (const dispose of disposers) dispose();
    await session.close();
  });
});

describe("wireTelephonyOutboundPipeline.drainAndClose", () => {
  it("resolves immediately when the playout queue is idle", async () => {
    const socket = createMockSocket();
    const { handle, disposers } = wireTestPipeline(socket);

    const startedAt = Date.now();
    await handle.drainAndClose(socket, Date.now() + 30_000);
    expect(Date.now() - startedAt).toBeLessThan(500);

    for (const dispose of disposers) dispose();
  });

  it("settles promptly when the socket closes before queued playout control runs", async () => {
    const socket = createMockSocket();
    const { session, handle, disposers } = wireTestPipeline(socket);

    const longAudio = pcm16SamplesToBytes(new Int16Array(8000 * 2));
    session.bus.push(Route.Main, {
      kind: "tts.audio",
      contextId: "turn-drain",
      timestampMs: Date.now(),
      audio: longAudio,
      sampleRateHz: 8000,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const startedAt = Date.now();
    const drainPromise = handle.drainAndClose(socket, Date.now() + 30_000);
    await new Promise((resolve) => setTimeout(resolve, 10));
    socket.close();
    await drainPromise;

    expect(Date.now() - startedAt).toBeLessThan(500);

    for (const dispose of disposers) dispose();
  });
});
