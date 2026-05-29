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
    await waitFor(controlMessages, 2);
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
    const send = vi.fn();
    Object.assign(plugin as unknown as { ready: boolean; ws: { readyState: number; OPEN: number; send: typeof send; close: () => void } }, {
      ready: true,
      ws: { readyState: 3, OPEN: 1, send, close: vi.fn() },
    });
    bus.push(Route.Main, {
      kind: "stt.audio",
      contextId: "turn-unsent",
      timestampMs: Date.now(),
      audio: new Uint8Array(640),
    });

    await waitFor(errors);
    expect(send).not.toHaveBeenCalled();
    expect(errors).toEqual([
      expect.objectContaining({
        kind: "stt.error",
        contextId: "turn-unsent",
        component: "stt",
        cause: expect.objectContaining({
          message: "Deepgram STT WebSocket is not open",
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

  it("reconnects after an unconfirmed Finalize timeout and discards stale provider text", async () => {
    const connections: WebSocket[] = [];
    const endpointUrl = await createLocalServer((socket) => {
      connections.push(socket);
      if (connections.length === 1) {
        socket.on("message", (data, isBinary) => {
          if (isBinary) {
            socket.send(JSON.stringify({
              is_final: true,
              speech_final: false,
              channel: { alternatives: [{ transcript: "stale buffered text", confidence: 0.8 }] },
            }));
            return;
          }
          const msg = JSON.parse(data.toString()) as { type?: string };
          if (msg.type !== "Finalize") return;
          setTimeout(() => {
            if (socket.readyState === socket.OPEN) {
              socket.send(JSON.stringify({
                is_final: true,
                speech_final: true,
                channel: { alternatives: [{ transcript: "late stale final", confidence: 0.95 }] },
              }));
            }
          }, 30);
        });
        return;
      }
      socket.on("message", (_data, isBinary) => {
        if (!isBinary) return;
        socket.send(JSON.stringify({
          is_final: true,
          speech_final: true,
          channel: { alternatives: [{ transcript: "fresh confirmed text", confidence: 0.9 }] },
        }));
      });
    });
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new DeepgramSTTPlugin();
    const finals: SttResultPacket[] = [];
    const errors: SttErrorPacket[] = [];
    bus.on("stt.result", (pkt) => {
      finals.push(pkt as SttResultPacket);
    });
    bus.on("stt.error", (pkt) => {
      errors.push(pkt as SttErrorPacket);
    });

    await plugin.initialize(bus, {
      api_key: "test",
      endpoint_url: endpointUrl,
      sample_rate: 16000,
      provider_finalize_timeout_ms: 10,
    });
    bus.push(Route.Main, {
      kind: "stt.audio",
      contextId: "turn-stale",
      timestampMs: Date.now(),
      audio: new Uint8Array(640),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    plugin.forceFinalize("turn-stale");
    await waitFor(errors);
    await waitFor(connections, 2);

    expect(finals).toHaveLength(0);
    expect(connections[0]?.readyState).toBe(connections[0]?.CLOSED);

    bus.push(Route.Main, {
      kind: "stt.audio",
      contextId: "turn-fresh",
      timestampMs: Date.now(),
      audio: new Uint8Array(640),
    });
    await waitFor(finals);

    expect(finals).toEqual([
      expect.objectContaining({
        contextId: "turn-fresh",
        text: "fresh confirmed text",
      }),
    ]);

    await plugin.close();
    bus.stop();
    await started;
  });
});
