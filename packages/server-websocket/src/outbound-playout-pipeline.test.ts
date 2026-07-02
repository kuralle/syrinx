// SPDX-License-Identifier: MIT

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Route, VoiceAgentSession } from "@kuralle-syrinx/core";
import { pcm16SamplesToBytes } from "@kuralle-syrinx/core/audio";
import { wireTelephonyOutboundPipeline, installTelephonyTurnRotation, type RotatableTurnContext } from "./outbound-playout-pipeline.js";

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
  it("drops the overflow tail at the cap without stopping playout or closing the socket", async () => {
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

    expect(stops).toEqual([]); // overflow is non-fatal — playout continues
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

describe("installTelephonyTurnRotation", () => {
  // Regression for the telephony "deaf after turn 1" P0: a carrier gives one
  // stream per call, but STT/TTS retire a contextId once its turn completes, so
  // reusing a single callSid id muted the agent after turn 1. Every turn must get
  // a fresh per-turn id with a turn.change boundary.
  it("rotates a per-turn contextId and emits turn.change on each completed turn", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    void session.start();
    const disposers: Array<() => void> = [];
    const state: RotatableTurnContext = {
      contextId: "twilio-CA123",
      contextBase: "twilio-CA123",
      turnCounter: 0,
    };
    const turnChanges: Array<{ contextId: string; previousContextId: string; reason: string }> = [];
    session.bus.on("turn.change", (pkt) => {
      const change = pkt as unknown as { contextId: string; previousContextId: string; reason: string };
      turnChanges.push({ contextId: change.contextId, previousContextId: change.previousContextId, reason: change.reason });
    });

    installTelephonyTurnRotation(session, disposers, state);

    // Turn 1 runs on the base id.
    expect(state.contextId).toBe("twilio-CA123");

    session.bus.push(Route.Main, { kind: "eos.turn_complete", contextId: "twilio-CA123", timestampMs: Date.now(), text: "one", transcripts: [] });
    await new Promise((r) => setTimeout(r, 0));
    expect(state.contextId).toBe("twilio-CA123-t1");

    session.bus.push(Route.Main, { kind: "eos.turn_complete", contextId: "twilio-CA123-t1", timestampMs: Date.now(), text: "two", transcripts: [] });
    await new Promise((r) => setTimeout(r, 0));
    expect(state.contextId).toBe("twilio-CA123-t2");

    expect(turnChanges).toEqual([
      { contextId: "twilio-CA123-t1", previousContextId: "twilio-CA123", reason: "telephony_turn_complete" },
      { contextId: "twilio-CA123-t2", previousContextId: "twilio-CA123-t1", reason: "telephony_turn_complete" },
    ]);

    for (const dispose of disposers) dispose();
    await session.close();
  });

  it("no-ops until a base is set", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    void session.start();
    const disposers: Array<() => void> = [];
    const state: RotatableTurnContext = { contextId: "", contextBase: "", turnCounter: 0 };
    installTelephonyTurnRotation(session, disposers, state);
    session.bus.push(Route.Main, { kind: "eos.turn_complete", contextId: "", timestampMs: Date.now(), text: "", transcripts: [] });
    await new Promise((r) => setTimeout(r, 0));
    expect(state.contextId).toBe("");
    expect(state.turnCounter).toBe(0);
    for (const dispose of disposers) dispose();
    await session.close();
  });
});
