// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import {
  PipelineBusImpl,
  Route,
  type ConversationMetricPacket,
  type SttErrorPacket,
  type SttResultPacket,
} from "@asyncdot/voice";

import { DeepgramSTTPlugin } from "./index.js";

let servers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) client.terminate();
          server.close(() => resolve());
        }),
    ),
  );
});

async function createLocalServer(onConnection: (socket: WebSocket) => void): Promise<string> {
  const server = await new Promise<WebSocketServer>((resolve) => {
    let nextServer: WebSocketServer;
    nextServer = new WebSocketServer({ port: 0 }, () => {
      resolve(nextServer);
    });
  });
  servers.push(server);
  server.on("connection", onConnection);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address");
  return `ws://127.0.0.1:${address.port}/listen`;
}

function startBus(bus: PipelineBusImpl): Promise<void> {
  return bus.start();
}

async function waitFor<T>(items: T[], count = 1): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (items.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForValue<T>(items: T[], value: T): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (items.includes(value)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("DeepgramSTTPlugin", () => {
  it("uses provider KeepAlive while idle and CloseStream on shutdown", async () => {
    const controlMessages: string[] = [];
    const endpointUrl = await createLocalServer((socket) => {
      socket.on("message", (data, isBinary) => {
        if (isBinary) return;
        const msg = JSON.parse(data.toString()) as { type?: string };
        if (msg.type) controlMessages.push(msg.type);
      });
    });
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new DeepgramSTTPlugin();

    await plugin.initialize(bus, {
      api_key: "test",
      endpoint_url: endpointUrl,
      sample_rate: 16000,
      keep_alive_interval_ms: 10,
    });
    await waitFor(controlMessages);
    await plugin.close();
    await waitForValue(controlMessages, "CloseStream");
    bus.stop();
    await started;

    expect(controlMessages).toContain("KeepAlive");
    expect(controlMessages.at(-1)).toBe("CloseStream");
  });

  it("releases an already closed provider-final buffer after explicit finalization", async () => {
    let finalizeMessages = 0;
    const endpointUrl = await createLocalServer((socket) => {
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          socket.send(JSON.stringify({
            is_final: true,
            speech_final: true,
            channel: { alternatives: [{ transcript: "premature", confidence: 0.8 }] },
          }));
          return;
        }
        const msg = JSON.parse(data.toString()) as { type?: string };
        if (msg.type !== "Finalize") return;
        finalizeMessages += 1;
        socket.send(JSON.stringify({
          is_final: true,
          speech_final: false,
          channel: { alternatives: [{ transcript: "partial", confidence: 0.7 }] },
        }));
        setTimeout(() => {
          socket.send(JSON.stringify({
            is_final: true,
            speech_final: false,
            from_finalize: true,
            channel: { alternatives: [{ transcript: "confirmed", confidence: 0.95 }] },
          }));
        }, 5);
      });
    });
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new DeepgramSTTPlugin();
    const finals: SttResultPacket[] = [];
    const metrics: ConversationMetricPacket[] = [];
    bus.on("stt.result", (pkt) => {
      finals.push(pkt as SttResultPacket);
    });
    bus.on("metric.conversation", (pkt) => {
      metrics.push(pkt as ConversationMetricPacket);
    });

    await plugin.initialize(bus, {
      api_key: "test",
      endpoint_url: endpointUrl,
      sample_rate: 16000,
      finalize_on_speech_final: false,
      provider_finalize_timeout_ms: 0,
      emit_eos_on_final: false,
    });
    bus.push(Route.Main, {
      kind: "stt.audio",
      contextId: "turn-1",
      timestampMs: Date.now(),
      audio: new Uint8Array(640),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(finals).toHaveLength(0);

    plugin.forceFinalize("turn-1");
    await new Promise((resolve) => setTimeout(resolve, 3));
    expect(finals).toEqual([
      expect.objectContaining({
        kind: "stt.result",
        contextId: "turn-1",
        text: "premature",
        confidence: 0.8,
      }),
    ]);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(finals).toHaveLength(1);
    expect(finalizeMessages).toBe(1);
    expect(metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "stt_provider_finalize_requested",
        contextId: "turn-1",
        value: expect.stringContaining("\"bytes\":640"),
      }),
      expect.objectContaining({
        name: "stt_provider_final_buffer_released",
        contextId: "turn-1",
        value: expect.stringContaining("\"bytes\":640"),
      }),
    ]));

    await plugin.close();
    bus.stop();
    await started;
  });

  it("waits for a trailing provider-final segment after Pipecat requests finalize", async () => {
    const endpointUrl = await createLocalServer((socket) => {
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          socket.send(JSON.stringify({
            is_final: true,
            speech_final: false,
            channel: { alternatives: [{ transcript: "first phrase", confidence: 0.8 }] },
          }));
          return;
        }
        const msg = JSON.parse(data.toString()) as { type?: string };
        if (msg.type !== "Finalize") return;
        setTimeout(() => {
          socket.send(JSON.stringify({
            is_final: true,
            speech_final: true,
            channel: { alternatives: [{ transcript: "trailing phrase", confidence: 0.9 }] },
          }));
        }, 10);
      });
    });
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new DeepgramSTTPlugin();
    const finals: SttResultPacket[] = [];
    bus.on("stt.result", (pkt) => {
      finals.push(pkt as SttResultPacket);
    });

    await plugin.initialize(bus, {
      api_key: "test",
      endpoint_url: endpointUrl,
      sample_rate: 16000,
      finalize_on_speech_final: false,
      provider_finalize_timeout_ms: 100,
      emit_eos_on_final: false,
    });
    bus.push(Route.Main, {
      kind: "stt.audio",
      contextId: "turn-2",
      timestampMs: Date.now(),
      audio: new Uint8Array(640),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    plugin.forceFinalize("turn-2");
    await new Promise((resolve) => setTimeout(resolve, 3));
    expect(finals).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(finals).toEqual([
      expect.objectContaining({
        contextId: "turn-2",
        text: "first phrase trailing phrase",
        confidence: 0.9,
      }),
    ]);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("turns malformed provider messages into STT errors instead of dropping them", async () => {
    const endpointUrl = await createLocalServer((socket) => {
      socket.on("message", (_data, isBinary) => {
        if (isBinary) socket.send("{not-json");
      });
    });
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new DeepgramSTTPlugin();
    const errors: SttErrorPacket[] = [];
    bus.on("stt.error", (pkt) => {
      errors.push(pkt as SttErrorPacket);
    });

    await plugin.initialize(bus, {
      api_key: "test",
      endpoint_url: endpointUrl,
      sample_rate: 16000,
    });
    bus.push(Route.Main, {
      kind: "stt.audio",
      contextId: "turn-malformed",
      timestampMs: Date.now(),
      audio: new Uint8Array(640),
    });

    await waitFor(errors);
    expect(errors).toEqual([
      expect.objectContaining({
        kind: "stt.error",
        contextId: "turn-malformed",
        component: "stt",
        isRecoverable: false,
        cause: expect.objectContaining({
          message: expect.stringContaining("Deepgram STT provider sent malformed JSON"),
        }),
      }),
    ]);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("surfaces Deepgram provider error frames as STT errors", async () => {
    const endpointUrl = await createLocalServer((socket) => {
      socket.on("message", (_data, isBinary) => {
        if (!isBinary) return;
        socket.send(JSON.stringify({
          type: "Error",
          code: "FAILED_TO_START_LISTENING",
          description: "Failed to open the listen connection.",
          request_id: "req-1",
        }));
      });
    });
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new DeepgramSTTPlugin();
    const errors: SttErrorPacket[] = [];
    bus.on("stt.error", (pkt) => {
      errors.push(pkt as SttErrorPacket);
    });

    await plugin.initialize(bus, {
      api_key: "test",
      endpoint_url: endpointUrl,
      sample_rate: 16000,
    });
    bus.push(Route.Main, {
      kind: "stt.audio",
      contextId: "turn-provider-error",
      timestampMs: Date.now(),
      audio: new Uint8Array(640),
    });

    await waitFor(errors);
    expect(errors).toEqual([
      expect.objectContaining({
        kind: "stt.error",
        contextId: "turn-provider-error",
        component: "stt",
        cause: expect.objectContaining({
          message: expect.stringContaining("FAILED_TO_START_LISTENING"),
        }),
      }),
    ]);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("surfaces unexpected Deepgram websocket close frames as STT errors", async () => {
    const endpointUrl = await createLocalServer((socket) => {
      socket.on("message", (_data, isBinary) => {
        if (isBinary) socket.close(1011, "NET-0000");
      });
    });
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new DeepgramSTTPlugin();
    const errors: SttErrorPacket[] = [];
    bus.on("stt.error", (pkt) => {
      errors.push(pkt as SttErrorPacket);
    });

    await plugin.initialize(bus, {
      api_key: "test",
      endpoint_url: endpointUrl,
      sample_rate: 16000,
    });
    bus.push(Route.Main, {
      kind: "stt.audio",
      contextId: "turn-close",
      timestampMs: Date.now(),
      audio: new Uint8Array(640),
    });

    await waitFor(errors);
    expect(errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "stt.error",
        contextId: "turn-close",
        component: "stt",
        isRecoverable: true,
        cause: expect.objectContaining({
          message: expect.stringContaining("code=1011 reason=NET-0000"),
        }),
      }),
    ]));

    await plugin.close();
    bus.stop();
    await started;
  });

  it("discards unconfirmed provider transcript state across recoverable websocket reconnect", async () => {
    const connections: WebSocket[] = [];
    const endpointUrl = await createLocalServer((socket) => {
      connections.push(socket);
      if (connections.length === 1) {
        socket.on("message", (_data, isBinary) => {
          if (!isBinary) return;
          socket.send(JSON.stringify({
            is_final: true,
            speech_final: false,
            channel: { alternatives: [{ transcript: "stale pre reconnect", confidence: 0.8 }] },
          }));
          socket.close(1011, "NET-0000");
        });
        return;
      }
      socket.on("message", (_data, isBinary) => {
        if (!isBinary) return;
        socket.send(JSON.stringify({
          is_final: true,
          speech_final: true,
          channel: { alternatives: [{ transcript: "fresh after reconnect", confidence: 0.9 }] },
        }));
      });
    });
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new DeepgramSTTPlugin();
    const finals: SttResultPacket[] = [];
    const metrics: ConversationMetricPacket[] = [];
    bus.on("stt.result", (pkt) => {
      finals.push(pkt as SttResultPacket);
    });
    bus.on("metric.conversation", (pkt) => {
      metrics.push(pkt as ConversationMetricPacket);
    });

    await plugin.initialize(bus, {
      api_key: "test",
      endpoint_url: endpointUrl,
      sample_rate: 16000,
    });
    bus.push(Route.Main, {
      kind: "stt.audio",
      contextId: "turn-before-reconnect",
      timestampMs: Date.now(),
      audio: new Uint8Array(640),
    });
    await waitFor(connections, 2);

    bus.push(Route.Main, {
      kind: "stt.audio",
      contextId: "turn-after-reconnect",
      timestampMs: Date.now(),
      audio: new Uint8Array(640),
    });
    await waitFor(finals);

    expect(finals).toEqual([
      expect.objectContaining({
        contextId: "turn-after-reconnect",
        text: "fresh after reconnect",
      }),
    ]);
    expect(metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "stt_provider_reconnect_discarded_state",
        contextId: "turn-before-reconnect",
      }),
    ]));

    await plugin.close();
    bus.stop();
    await started;
  });

  it("does not record STT audio bytes when the Deepgram websocket cannot accept the frame", async () => {
    const endpointUrl = await createLocalServer(() => {});
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new DeepgramSTTPlugin();
    const errors: SttErrorPacket[] = [];
    const metrics: ConversationMetricPacket[] = [];
    bus.on("stt.error", (pkt) => {
      errors.push(pkt as SttErrorPacket);
    });
    bus.on("metric.conversation", (pkt) => {
      metrics.push(pkt as ConversationMetricPacket);
    });

    await plugin.initialize(bus, {
      api_key: "test",
      endpoint_url: endpointUrl,
      sample_rate: 16000,
    });
    // Simulate a closed socket: the managed connection's send throws.
    const send = vi.fn(() => {
      throw new Error("WebSocket is not open");
    });
    Object.assign(plugin as unknown as { conn: { ensureReady: () => Promise<void>; send: typeof send; isReady: boolean; close: () => Promise<void> } }, {
      conn: { ensureReady: async () => undefined, send, isReady: false, close: async () => undefined },
    });
    bus.push(Route.Main, {
      kind: "stt.audio",
      contextId: "turn-unsent",
      timestampMs: Date.now(),
      audio: new Uint8Array(640),
    });

    await waitFor(errors);
    expect(send).toHaveBeenCalled();
    expect(errors).toEqual([
      expect.objectContaining({
        kind: "stt.error",
        contextId: "turn-unsent",
        component: "stt",
        cause: expect.objectContaining({
          message: "WebSocket is not open",
        }),
      }),
    ]);

    plugin.forceFinalize("turn-unsent");
    await waitFor(metrics);
    expect(metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "stt_provider_finalize_requested",
        contextId: "turn-unsent",
        value: expect.stringContaining("\"bytes\":0"),
      }),
    ]));

    await plugin.close();
    bus.stop();
    await started;
  });

  it("does not promote cached provider text when Finalize is not confirmed", async () => {
    const endpointUrl = await createLocalServer((socket) => {
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          socket.send(JSON.stringify({
            is_final: true,
            speech_final: false,
            channel: { alternatives: [{ transcript: "unconfirmed segment", confidence: 0.8 }] },
          }));
          return;
        }
        const msg = JSON.parse(data.toString()) as { type?: string };
        if (msg.type !== "Finalize") return;
      });
    });
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new DeepgramSTTPlugin();
    const finals: SttResultPacket[] = [];
    const errors: SttErrorPacket[] = [];
    const metrics: ConversationMetricPacket[] = [];
    bus.on("stt.result", (pkt) => {
      finals.push(pkt as SttResultPacket);
    });
    bus.on("stt.error", (pkt) => {
      errors.push(pkt as SttErrorPacket);
    });
    bus.on("metric.conversation", (pkt) => {
      metrics.push(pkt as ConversationMetricPacket);
    });

    await plugin.initialize(bus, {
      api_key: "test",
      endpoint_url: endpointUrl,
      sample_rate: 16000,
      finalize_on_speech_final: false,
      provider_finalize_timeout_ms: 10,
      emit_eos_on_final: false,
    });
    bus.push(Route.Main, {
      kind: "stt.audio",
      contextId: "turn-unconfirmed",
      timestampMs: Date.now(),
      audio: new Uint8Array(640),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    plugin.forceFinalize("turn-unconfirmed");
    await waitFor(errors);

    expect(finals).toHaveLength(0);
    expect(errors).toEqual([
      expect.objectContaining({
        kind: "stt.error",
        contextId: "turn-unconfirmed",
        isRecoverable: true,
        cause: expect.objectContaining({
          message: "Deepgram STT Finalize timed out before speech_final/from_finalize confirmation",
        }),
      }),
    ]);
    expect(metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "stt_provider_finalize_timeout",
        contextId: "turn-unconfirmed",
        value: expect.stringContaining("\"bytes\":640"),
      }),
    ]));

    await plugin.close();
    bus.stop();
    await started;
  });

  it("keeps the live connection after a single unconfirmed Finalize timeout", async () => {
    // A lone slow finalize must NOT tear down the socket — the next turn has to stream
    // on the same connection, otherwise a reconnect stall cascades into more timeouts.
    const connections: WebSocket[] = [];
    let lastAudioContext = "";
    const endpointUrl = await createLocalServer((socket) => {
      connections.push(socket);
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          // Only the fresh turn gets a confirming speech_final; the stale turn's
          // Finalize is intentionally never confirmed so it times out.
          const forFreshTurn = lastAudioContext === "turn-fresh";
          socket.send(JSON.stringify({
            is_final: true,
            speech_final: forFreshTurn,
            channel: { alternatives: [{ transcript: forFreshTurn ? "fresh confirmed text" : "stale interim", confidence: 0.9 }] },
          }));
          return;
        }
        // Swallow Finalize for the stale turn (no from_finalize) → provider timeout.
      });
    });
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new DeepgramSTTPlugin();
    const finals: SttResultPacket[] = [];
    const errors: SttErrorPacket[] = [];
    bus.on("stt.result", (pkt) => { finals.push(pkt as SttResultPacket); });
    bus.on("stt.error", (pkt) => { errors.push(pkt as SttErrorPacket); });

    await plugin.initialize(bus, {
      api_key: "test",
      endpoint_url: endpointUrl,
      sample_rate: 16000,
      provider_finalize_timeout_ms: 10,
    });

    lastAudioContext = "turn-stale";
    bus.push(Route.Main, { kind: "stt.audio", contextId: "turn-stale", timestampMs: Date.now(), audio: new Uint8Array(640) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    plugin.forceFinalize("turn-stale");
    await waitFor(errors);

    // The single timeout surfaced an error but the socket stayed up (no reconnect).
    expect(errors).toHaveLength(1);
    expect(connections).toHaveLength(1);
    expect(connections[0]?.readyState).toBe(connections[0]?.OPEN);

    // Next turn streams on the SAME connection and completes normally.
    lastAudioContext = "turn-fresh";
    bus.push(Route.Main, { kind: "stt.audio", contextId: "turn-fresh", timestampMs: Date.now(), audio: new Uint8Array(640) });
    await waitFor(finals);

    expect(connections).toHaveLength(1);
    expect(finals).toEqual([
      expect.objectContaining({ contextId: "turn-fresh", text: "fresh confirmed text" }),
    ]);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("reconnects only after consecutive unconfirmed Finalize timeouts", async () => {
    // Two finalize timeouts in a row with no confirmed final between them looks like a
    // genuinely wedged stream → reconnect; the fresh socket then serves the next turn.
    const connections: WebSocket[] = [];
    const endpointUrl = await createLocalServer((socket) => {
      connections.push(socket);
      const connIndex = connections.length;
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          if (connIndex >= 2) {
            socket.send(JSON.stringify({
              is_final: true,
              speech_final: true,
              channel: { alternatives: [{ transcript: "fresh confirmed text", confidence: 0.9 }] },
            }));
          } else {
            socket.send(JSON.stringify({
              is_final: true,
              speech_final: false,
              channel: { alternatives: [{ transcript: "wedged interim", confidence: 0.8 }] },
            }));
          }
          return;
        }
        // First connection never confirms any Finalize → repeated timeouts.
      });
    });
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new DeepgramSTTPlugin();
    const finals: SttResultPacket[] = [];
    const errors: SttErrorPacket[] = [];
    bus.on("stt.result", (pkt) => { finals.push(pkt as SttResultPacket); });
    bus.on("stt.error", (pkt) => { errors.push(pkt as SttErrorPacket); });

    await plugin.initialize(bus, {
      api_key: "test",
      endpoint_url: endpointUrl,
      sample_rate: 16000,
      provider_finalize_timeout_ms: 10,
      finalize_reset_threshold: 2,
    });

    bus.push(Route.Main, { kind: "stt.audio", contextId: "turn-1", timestampMs: Date.now(), audio: new Uint8Array(640) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    plugin.forceFinalize("turn-1");
    await waitFor(errors, 1);
    // First timeout: still one connection (no reconnect yet).
    expect(connections).toHaveLength(1);

    bus.push(Route.Main, { kind: "stt.audio", contextId: "turn-2", timestampMs: Date.now(), audio: new Uint8Array(640) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    plugin.forceFinalize("turn-2");
    await waitFor(errors, 2);
    await waitFor(connections, 2);

    // Second consecutive timeout: now it reconnects and abandons the wedged socket.
    expect(connections[0]?.readyState).toBe(connections[0]?.CLOSED);

    bus.push(Route.Main, { kind: "stt.audio", contextId: "turn-fresh", timestampMs: Date.now(), audio: new Uint8Array(640) });
    await waitFor(finals);
    expect(finals).toEqual([
      expect.objectContaining({ contextId: "turn-fresh", text: "fresh confirmed text" }),
    ]);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("clears the consecutive-timeout counter across a real socket reconnect", async () => {
    // A timeout (counter->1) followed by an unrelated socket-close reconnect must not leave
    // the count stale: a single timeout after reconnecting should NOT force another reset.
    const connections: WebSocket[] = [];
    const endpointUrl = await createLocalServer((socket) => {
      connections.push(socket);
      socket.on("message", (_data, isBinary) => {
        if (!isBinary) return;
        socket.send(JSON.stringify({
          is_final: true,
          speech_final: false,
          channel: { alternatives: [{ transcript: "unconfirmed", confidence: 0.8 }] },
        }));
      });
    });
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new DeepgramSTTPlugin();
    const timeoutErrors: SttErrorPacket[] = [];
    bus.on("stt.error", (pkt) => {
      const p = pkt as SttErrorPacket;
      if (String((p.cause as Error | undefined)?.message ?? "").includes("Finalize timed out")) {
        timeoutErrors.push(p);
      }
    });

    await plugin.initialize(bus, {
      api_key: "test",
      endpoint_url: endpointUrl,
      sample_rate: 16000,
      provider_finalize_timeout_ms: 10,
      finalize_reset_threshold: 2,
    });

    // Turn 1: one finalize timeout → counter 1 (below threshold, no reset yet).
    bus.push(Route.Main, { kind: "stt.audio", contextId: "turn-before-reconnect", timestampMs: Date.now(), audio: new Uint8Array(640) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    plugin.forceFinalize("turn-before-reconnect");
    await waitFor(timeoutErrors, 1);
    expect(connections).toHaveLength(1);

    // An unrelated socket-close reconnect happens.
    connections[0]!.close(1011, "NET-0000");
    await waitFor(connections, 2);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Turn 2: a single post-reconnect timeout must NOT reconnect again — the counter was
    // cleared on the reconnect, so it is 1 (< threshold 2), not a stale 2.
    bus.push(Route.Main, { kind: "stt.audio", contextId: "turn-after-reconnect", timestampMs: Date.now(), audio: new Uint8Array(640) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    plugin.forceFinalize("turn-after-reconnect");
    await waitFor(timeoutErrors, 2);
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Would be 3 without clearing the counter on reconnect.
    expect(connections).toHaveLength(2);
    expect(connections[1]?.readyState).toBe(connections[1]?.OPEN);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("completes a timed-out turn from buffered text when finalize_timeout_fallback is on", async () => {
    // Provider sends a confirmed is_final segment but never speech_final/from_finalize, so the
    // turn would normally time out and be dropped. With the fallback on it must still emit an
    // stt.result (which drives the turn plugin → LLM) instead of a "Finalize timed out" error.
    const endpointUrl = await createLocalServer((socket) => {
      socket.on("message", (_data, isBinary) => {
        if (!isBinary) return; // swallow Finalize → provider never confirms
        socket.send(JSON.stringify({
          is_final: true,
          speech_final: false,
          channel: { alternatives: [{ transcript: "buffered text", confidence: 0.82 }] },
        }));
      });
    });
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new DeepgramSTTPlugin();
    const finals: SttResultPacket[] = [];
    const errors: SttErrorPacket[] = [];
    bus.on("stt.result", (pkt) => { finals.push(pkt as SttResultPacket); });
    bus.on("stt.error", (pkt) => { errors.push(pkt as SttErrorPacket); });

    await plugin.initialize(bus, {
      api_key: "test",
      endpoint_url: endpointUrl,
      sample_rate: 16000,
      emit_eos_on_final: false,
      finalize_on_speech_final: false,
      provider_finalize_timeout_ms: 10,
      finalize_timeout_fallback: true,
    });

    bus.push(Route.Main, { kind: "stt.audio", contextId: "turn-timeout-fallback", timestampMs: Date.now(), audio: new Uint8Array(640) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    plugin.forceFinalize("turn-timeout-fallback");
    await waitFor(finals);

    expect(finals).toEqual([
      expect.objectContaining({ kind: "stt.result", contextId: "turn-timeout-fallback", text: "buffered text" }),
    ]);
    expect(
      errors.filter((e) => String((e.cause as Error | undefined)?.message ?? "").includes("Finalize timed out")),
    ).toHaveLength(0);

    await plugin.close();
    bus.stop();
    await started;
  });
});
