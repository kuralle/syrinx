// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import {
  PipelineBusImpl,
  Route,
  type SttErrorPacket,
  type SttInterimPacket,
  type SttResultPacket,
  type UsageRecordedPacket,
} from "@kuralle-syrinx/core";

import { GrokSTTPlugin } from "./stt.js";

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
  return `ws://127.0.0.1:${address.port}/stt`;
}

async function waitFor<T>(items: T[], count = 1): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (items.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("GrokSTTPlugin", () => {
  it("waits for transcript.created before sending binary audio", async () => {
    const binaryFrames: Uint8Array[] = [];
    const controlMessages: string[] = [];
    const endpointUrl = await createLocalServer((socket) => {
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          binaryFrames.push(new Uint8Array(data as Buffer));
          return;
        }
        controlMessages.push(data.toString());
      });
      socket.send(JSON.stringify({ type: "transcript.created" }));
    });

    const bus = new PipelineBusImpl();
    const started = bus.start();
    const plugin = new GrokSTTPlugin();

    await plugin.initialize(bus, {
      api_key: "test",
      endpoint_url: endpointUrl,
      sample_rate: 16000,
    });
    bus.push(Route.Media, {
      kind: "stt.audio",
      contextId: "turn-1",
      timestampMs: Date.now(),
      audio: new Uint8Array(640),
    });
    await waitFor(binaryFrames);

    expect(binaryFrames).toEqual([new Uint8Array(640)]);
    expect(controlMessages).toEqual([]);

    await plugin.close();
    await waitFor(controlMessages);
    expect(controlMessages).toContain(JSON.stringify({ type: "audio.done" }));
    bus.stop();
    await started;
  });

  it("maps transcript.partial to stt.interim and stt.result", async () => {
    const endpointUrl = await createLocalServer((socket) => {
      socket.send(JSON.stringify({ type: "transcript.created" }));
      socket.on("message", (data, isBinary) => {
        if (!isBinary) return;
        socket.send(JSON.stringify({
          type: "transcript.partial",
          text: "hello",
          is_final: false,
        }));
        socket.send(JSON.stringify({
          type: "transcript.partial",
          text: "hello world",
          is_final: true,
          speech_final: false,
          words: [{ word: "hello" }, { word: "world" }],
          start: 0,
          duration: 1.2,
          end_of_turn_confidence: 0.91,
        }));
        socket.send(JSON.stringify({
          type: "transcript.partial",
          text: "hello world",
          is_final: true,
          speech_final: true,
          end_of_turn_confidence: 0.95,
        }));
      });
    });

    const bus = new PipelineBusImpl();
    const started = bus.start();
    const plugin = new GrokSTTPlugin();
    const interims: Array<{ text: string }> = [];
    const finals: SttResultPacket[] = [];
    const turnCompletes: Array<{ kind: string }> = [];
    bus.on("stt.interim", (pkt) => {
      interims.push({ text: (pkt as SttInterimPacket).text });
    });
    bus.on("stt.result", (pkt) => {
      finals.push(pkt as SttResultPacket);
    });
    bus.on("eos.turn_complete", (pkt) => {
      turnCompletes.push(pkt as { kind: string });
    });

    await plugin.initialize(bus, {
      api_key: "test",
      endpoint_url: endpointUrl,
      sample_rate: 16000,
    });
    bus.push(Route.Media, {
      kind: "stt.audio",
      contextId: "turn-2",
      timestampMs: Date.now(),
      audio: new Uint8Array(320),
    });
    await waitFor(finals, 2);
    await waitFor(turnCompletes);

    expect(interims).toEqual([{ text: "hello" }]);
    expect(finals[0]).toEqual(
      expect.objectContaining({
        kind: "stt.result",
        contextId: "turn-2",
        text: "hello world",
        confidence: 0.91,
        provider: expect.objectContaining({
          name: "grok",
          speechFinal: false,
          words: [{ word: "hello" }, { word: "world" }],
          start: 0,
          duration: 1.2,
        }),
      }),
    );
    expect(finals[1]).toEqual(
      expect.objectContaining({
        text: "hello world",
        confidence: 0.95,
        provider: expect.objectContaining({ speechFinal: true }),
      }),
    );
    expect(turnCompletes).toHaveLength(1);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("sends audio.done on stt.finalize", async () => {
    const controlMessages: string[] = [];
    const endpointUrl = await createLocalServer((socket) => {
      socket.send(JSON.stringify({ type: "transcript.created" }));
      socket.on("message", (data, isBinary) => {
        if (!isBinary) controlMessages.push(data.toString());
      });
    });

    const bus = new PipelineBusImpl();
    const started = bus.start();
    const plugin = new GrokSTTPlugin();

    await plugin.initialize(bus, {
      api_key: "test",
      endpoint_url: endpointUrl,
      sample_rate: 16000,
    });
    bus.push(Route.Main, {
      kind: "stt.finalize",
      contextId: "turn-3",
      timestampMs: Date.now(),
    });
    await waitFor(controlMessages);

    expect(JSON.parse(controlMessages[0]!)).toEqual({ type: "audio.done" });

    await plugin.close();
    bus.stop();
    await started;
  });

  it("emits usage.recorded with stage stt and audioSeconds from provider duration at final", async () => {
    let binarySeen = 0;
    const endpointUrl = await createLocalServer((socket) => {
      socket.send(JSON.stringify({ type: "transcript.created" }));
      socket.on("message", (data, isBinary) => {
        if (!isBinary) return;
        binarySeen += 1;
        socket.send(JSON.stringify({
          type: "transcript.partial",
          text: "hello world",
          is_final: true,
          speech_final: true,
          duration: 1.2,
          end_of_turn_confidence: 0.95,
        }));
      });
    });

    const bus = new PipelineBusImpl();
    const started = bus.start();
    const plugin = new GrokSTTPlugin();
    const usage: UsageRecordedPacket[] = [];
    bus.on("usage.recorded", (pkt) => {
      usage.push(pkt as UsageRecordedPacket);
    });

    await plugin.initialize(bus, {
      api_key: "test",
      endpoint_url: endpointUrl,
      sample_rate: 16000,
    });
    // transcript.created must land before binary audio is accepted.
    await new Promise((resolve) => setTimeout(resolve, 20));
    bus.push(Route.Media, {
      kind: "stt.audio",
      contextId: "turn-usage",
      timestampMs: Date.now(),
      audio: new Uint8Array(640),
    });
    for (let i = 0; i < 100 && (binarySeen < 1 || usage.length < 1); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(usage).toEqual([
      expect.objectContaining({
        kind: "usage.recorded",
        contextId: "turn-usage",
        stage: "stt",
        provider: "grok",
        model: "stt",
        audioSeconds: 1.2,
      }),
    ]);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("emits usage.recorded under smart-turn endpointing (emit_eos_on_final=false)", async () => {
    let binarySeen = 0;
    const endpointUrl = await createLocalServer((socket) => {
      socket.send(JSON.stringify({ type: "transcript.created" }));
      socket.on("message", (data, isBinary) => {
        if (!isBinary) return;
        binarySeen += 1;
        socket.send(JSON.stringify({
          type: "transcript.partial",
          text: "account number please",
          is_final: true,
          speech_final: false,
          duration: 0.8,
          end_of_turn_confidence: 0.9,
        }));
      });
    });

    const bus = new PipelineBusImpl();
    const started = bus.start();
    const plugin = new GrokSTTPlugin();
    const usage: UsageRecordedPacket[] = [];
    bus.on("usage.recorded", (pkt) => {
      usage.push(pkt as UsageRecordedPacket);
    });

    await plugin.initialize(bus, {
      api_key: "test",
      endpoint_url: endpointUrl,
      sample_rate: 16000,
      emit_eos_on_final: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    bus.push(Route.Media, {
      kind: "stt.audio",
      contextId: "turn-smartturn",
      timestampMs: Date.now(),
      audio: new Uint8Array(320),
    });
    for (let i = 0; i < 100 && (binarySeen < 1 || usage.length < 1); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(usage).toEqual([
      expect.objectContaining({
        kind: "usage.recorded",
        contextId: "turn-smartturn",
        stage: "stt",
        provider: "grok",
        model: "stt",
        audioSeconds: 0.8,
      }),
    ]);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("maps provider error frames to stt.error", async () => {
    const endpointUrl = await createLocalServer((socket) => {
      socket.send(JSON.stringify({ type: "error", message: "bad audio format" }));
    });
    const bus = new PipelineBusImpl();
    const started = bus.start();
    const plugin = new GrokSTTPlugin();
    const errors: SttErrorPacket[] = [];
    bus.on("stt.error", (pkt) => {
      errors.push(pkt as SttErrorPacket);
    });

    await plugin.initialize(bus, {
      api_key: "test",
      endpoint_url: endpointUrl,
      sample_rate: 16000,
    });
    await waitFor(errors);

    expect(errors[0]).toEqual(
      expect.objectContaining({
        kind: "stt.error",
        cause: expect.objectContaining({ message: "bad audio format" }),
      }),
    );

    await plugin.close();
    bus.stop();
    await started;
  });

  it("puts named knobs and query_params on the STT websocket URL", async () => {
    const connectionUrls: string[] = [];
    const server = await new Promise<WebSocketServer>((resolve) => {
      let nextServer: WebSocketServer;
      nextServer = new WebSocketServer({ port: 0 }, () => resolve(nextServer));
    });
    servers.push(server);
    server.on("connection", (socket, req) => {
      connectionUrls.push(req.url ?? "");
      socket.send(JSON.stringify({ type: "transcript.created" }));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server address");
    const endpointUrl = `ws://127.0.0.1:${address.port}/stt`;

    const bus = new PipelineBusImpl();
    const started = bus.start();
    const plugin = new GrokSTTPlugin();
    await plugin.initialize(bus, {
      api_key: "test",
      endpoint_url: endpointUrl,
      sample_rate: 8000,
      encoding: "mulaw",
      language: "es",
      endpointing: 25,
      interim_results: false,
      diarize: true,
      keyterm: "Syrinx",
      smart_turn: 0.8,
      smart_turn_timeout: 1500,
      query_params: {
        custom_flag: "on",
        tag: ["a", "b"],
      },
    });
    await waitFor(connectionUrls);
    await plugin.close();
    bus.stop();
    await started;

    const url = connectionUrls[0]!;
    expect(url).toContain("sample_rate=8000");
    expect(url).toContain("encoding=mulaw");
    expect(url).toContain("language=es");
    expect(url).toContain("endpointing=25");
    expect(url).toContain("interim_results=false");
    expect(url).toContain("diarize=true");
    expect(url).toContain("keyterm=Syrinx");
    expect(url).toContain("smart_turn=0.8");
    expect(url).toContain("smart_turn_timeout=1500");
    expect(url).toContain("custom_flag=on");
    expect(url).toContain("tag=a");
    expect(url).toContain("tag=b");
  });
});
