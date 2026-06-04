// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import {
  PipelineBusImpl,
  Route,
  type SttErrorPacket,
  type SttInterimPacket,
  type SttResultPacket,
  type EndOfSpeechPacket,
} from "@asyncdot/voice";
import { GoogleSTTPlugin } from "./index.js";

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
  return `ws://127.0.0.1:${address.port}`;
}

function startBus(bus: PipelineBusImpl): Promise<void> {
  const started = bus.start();
  return started;
}

describe("GoogleSTTPlugin", () => {
  it("pushes interim and final packets from Google streaming responses", async () => {
    const endpointUrl = await createLocalServer((socket) => {
      socket.once("message", () => {
        socket.send(JSON.stringify({
          results: [{
            isFinal: false,
            alternatives: [{ transcript: "hello", confidence: 0.7 }],
          }],
        }));
        socket.send(JSON.stringify({
          results: [{
            isFinal: true,
            alternatives: [{ transcript: "hello world", confidence: 0.95 }],
          }],
        }));
      });
    });
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new GoogleSTTPlugin();
    const interims: SttInterimPacket[] = [];
    const finals: SttResultPacket[] = [];
    bus.on("stt.interim", (pkt) => {
      interims.push(pkt as SttInterimPacket);
    });
    bus.on("stt.result", (pkt) => {
      finals.push(pkt as SttResultPacket);
    });

    await plugin.initialize(bus, {
      api_key: "test",
      project_id: "test-project",
      endpoint_url: endpointUrl,
    });
    bus.push(Route.Main, {
      kind: "stt.audio",
      contextId: "turn-1",
      timestampMs: Date.now(),
      audio: new Uint8Array([1, 2, 3, 4]),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(interims).toEqual([
      expect.objectContaining({ kind: "stt.interim", contextId: "turn-1", text: "hello" }),
    ]);
    expect(finals).toEqual([
      expect.objectContaining({
        kind: "stt.result",
        contextId: "turn-1",
        text: "hello world",
        confidence: 0.95,
        language: "en-US",
      }),
    ]);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("reconnects after a recoverable socket close before sending later audio", async () => {
    let connections = 0;
    const receivedFrames: Array<{ connection: number; kind: "config" | "audio"; payload: unknown }> = [];
    const endpointUrl = await createLocalServer((socket) => {
      connections++;
      const connection = connections;
      if (connections === 1) {
        socket.close();
        return;
      }
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          receivedFrames.push({ connection, kind: "audio", payload: Buffer.from(data as Buffer) });
        } else {
          receivedFrames.push({ connection, kind: "config", payload: JSON.parse(data.toString()) });
        }
      });
    });
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new GoogleSTTPlugin();

    await plugin.initialize(bus, {
      api_key: "test",
      project_id: "test-project",
      endpoint_url: endpointUrl,
      retry_base_delay_ms: 1,
      retry_max_delay_ms: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    bus.push(Route.Main, {
      kind: "stt.audio",
      contextId: "turn-1",
      timestampMs: Date.now(),
      audio: new Uint8Array([9, 8, 7, 6]),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(connections).toBeGreaterThanOrEqual(2);
    expect(receivedFrames).toEqual([
      expect.objectContaining({ connection: 2, kind: "config" }),
      expect.objectContaining({ connection: 2, kind: "audio", payload: Buffer.from([9, 8, 7, 6]) }),
    ]);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("uses configured sample_rate in the audio contract and Google decoding config", async () => {
    const configs: any[] = [];
    const endpointUrl = await createLocalServer((socket) => {
      socket.on("message", (data, isBinary) => {
        if (!isBinary) configs.push(JSON.parse(data.toString()));
      });
    });
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new GoogleSTTPlugin();

    await plugin.initialize(bus, {
      api_key: "test",
      project_id: "test-project",
      endpoint_url: endpointUrl,
      sample_rate: 8000,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(configs[0]?.streamingConfig?.config?.explicitDecodingConfig?.sampleRateHertz).toBe(8000);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("suppresses EOS when Smart Turn ownership disables provider finalization", async () => {
    const endpointUrl = await createLocalServer((socket) => {
      socket.once("message", () => {
        socket.send(JSON.stringify({
          results: [{
            isFinal: true,
            alternatives: [{ transcript: "hello world", confidence: 0.95 }],
          }],
        }));
      });
    });
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new GoogleSTTPlugin();
    const finals: SttResultPacket[] = [];
    const eos: EndOfSpeechPacket[] = [];
    bus.on("stt.result", (pkt) => {
      finals.push(pkt as SttResultPacket);
    });
    bus.on("eos.turn_complete", (pkt) => {
      eos.push(pkt as EndOfSpeechPacket);
    });

    await plugin.initialize(bus, {
      api_key: "test",
      project_id: "test-project",
      endpoint_url: endpointUrl,
      emit_eos_on_final: false,
    });
    bus.push(Route.Main, {
      kind: "stt.audio",
      contextId: "turn-no-eos",
      timestampMs: Date.now(),
      audio: new Uint8Array([1, 2, 3, 4]),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(finals).toHaveLength(1);
    expect(eos).toEqual([]);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("emits stt.error for odd-length PCM16 without throwing into the bus pump", async () => {
    const receivedAudio: Buffer[] = [];
    const endpointUrl = await createLocalServer((socket) => {
      socket.on("message", (data, isBinary) => {
        if (isBinary) receivedAudio.push(data as Buffer);
      });
    });
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const plugin = new GoogleSTTPlugin();
    const errors: SttErrorPacket[] = [];
    bus.on("stt.error", (pkt) => {
      errors.push(pkt as SttErrorPacket);
    });

    await plugin.initialize(bus, {
      api_key: "test",
      project_id: "test-project",
      endpoint_url: endpointUrl,
    });
    bus.push(Route.Main, {
      kind: "stt.audio",
      contextId: "turn-bad",
      timestampMs: Date.now(),
      audio: new Uint8Array([1, 2, 3]),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(errors).toEqual([
      expect.objectContaining({
        kind: "stt.error",
        contextId: "turn-bad",
        component: "stt",
        cause: expect.objectContaining({
          message: expect.stringMatching(/even number of bytes/i),
        }),
      }),
    ]);
    expect(receivedAudio).toEqual([]);

    await plugin.close();
    bus.stop();
    await started;
  });
});
