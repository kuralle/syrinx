// SPDX-License-Identifier: MIT

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Route, VoiceAgentSession } from "@asyncdot/voice";
import { pcm16SamplesToBytes } from "@asyncdot/voice/audio";
import { wireTelephonyOutboundPipeline } from "./outbound-playout-pipeline.js";

function createMockSocket(): WebSocket & EventEmitter {
  const emitter = new EventEmitter();
  const socket = emitter as WebSocket & EventEmitter;
  socket.readyState = WebSocket.OPEN;
  socket.close = () => {
    socket.readyState = WebSocket.CLOSED;
    emitter.emit("close");
  };
  socket.terminate = socket.close;
  return socket;
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
    },
  });
  return { session, handle, disposers };
}

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
