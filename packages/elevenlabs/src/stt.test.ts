// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import {
  PipelineBusImpl,
  Route,
  type SttInterimPacket,
  type SttResultPacket,
  type UsageRecordedPacket,
} from "@kuralle-syrinx/core";

import { ElevenLabsSTTPlugin } from "./stt.js";

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

async function createLocalServer(
  onConnection: (socket: WebSocket, requestUrl: string, apiKeyHeader: string) => void,
): Promise<string> {
  const server = await new Promise<WebSocketServer>((resolve) => {
    let nextServer: WebSocketServer;
    nextServer = new WebSocketServer({ port: 0 }, () => {
      resolve(nextServer);
    });
  });
  servers.push(server);
  server.on("connection", (socket, request) => {
    const header = request.headers["xi-api-key"];
    onConnection(socket, request.url ?? "", Array.isArray(header) ? header[0] ?? "" : header ?? "");
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address");
  return `ws://127.0.0.1:${address.port}/v1/speech-to-text/realtime`;
}

async function waitFor<T>(items: T[], count = 1, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (items.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for ElevenLabs STT test condition");
}

describe("ElevenLabsSTTPlugin", () => {
  it("maps partial_transcript → stt.interim and committed_transcript → stt.result with usage", async () => {
    const inbound: Array<Record<string, unknown>> = [];
    const endpointUrl = await createLocalServer((socket, requestUrl, apiKeyHeader) => {
      expect(apiKeyHeader).toBe("test-el-key");
      expect(requestUrl).toContain("model_id=scribe_v2_realtime");
      expect(requestUrl).toContain("audio_format=pcm_16000");
      expect(requestUrl).toContain("commit_strategy=manual");
      socket.send(JSON.stringify({ message_type: "session_started", session_id: "s1", config: {} }));
      socket.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        inbound.push(msg);
        if (msg["commit"] === true) {
          socket.send(JSON.stringify({ message_type: "partial_transcript", text: "hello" }));
          socket.send(JSON.stringify({ message_type: "committed_transcript", text: "hello world" }));
          return;
        }
        if (msg["message_type"] === "input_audio_chunk" && msg["commit"] === false) {
          socket.send(JSON.stringify({ message_type: "partial_transcript", text: "hel" }));
        }
      });
    });

    const bus = new PipelineBusImpl();
    const started = bus.start();
    const plugin = new ElevenLabsSTTPlugin();
    const interims: SttInterimPacket[] = [];
    const finals: SttResultPacket[] = [];
    const usage: UsageRecordedPacket[] = [];
    bus.on("stt.interim", (pkt) => {
      interims.push(pkt as SttInterimPacket);
    });
    bus.on("stt.result", (pkt) => {
      finals.push(pkt as SttResultPacket);
    });
    bus.on("usage.recorded", (pkt) => {
      usage.push(pkt as UsageRecordedPacket);
    });

    await plugin.initialize(bus, {
      api_key: "test-el-key",
      endpoint_url: endpointUrl,
      sample_rate: 16000,
      model: "scribe_v2_realtime",
    });
    // 640 bytes pcm_s16le @ 16kHz = 0.02 s
    bus.push(Route.Media, {
      kind: "stt.audio",
      contextId: "turn-1",
      timestampMs: Date.now(),
      audio: new Uint8Array(640),
    });
    await waitFor(interims, 1);
    bus.push(Route.Main, {
      kind: "stt.finalize",
      contextId: "turn-1",
      timestampMs: Date.now(),
    });
    await waitFor(finals, 1);
    await waitFor(usage, 1);

    expect(inbound.some((m) => m["message_type"] === "input_audio_chunk" && m["commit"] === false)).toBe(true);
    expect(inbound.some((m) => m["message_type"] === "input_audio_chunk" && m["commit"] === true)).toBe(true);
    expect(interims.map((i) => i.text)).toEqual(expect.arrayContaining(["hel", "hello"]));
    expect(finals).toEqual([
      expect.objectContaining({
        kind: "stt.result",
        contextId: "turn-1",
        text: "hello world",
        provider: expect.objectContaining({ name: "elevenlabs", model: "scribe_v2_realtime" }),
      }),
    ]);
    expect(usage).toEqual([
      expect.objectContaining({
        kind: "usage.recorded",
        contextId: "turn-1",
        stage: "stt",
        provider: "elevenlabs",
        model: "scribe_v2_realtime",
        audioSeconds: 0.02,
      }),
    ]);

    await plugin.close();
    bus.stop();
    await started;
  });

  it("bills each committed segment's audio delta once (multi-segment, no double-bill)", async () => {
    let commits = 0;
    const endpointUrl = await createLocalServer((socket) => {
      socket.send(JSON.stringify({ message_type: "session_started", session_id: "s1", config: {} }));
      socket.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg["commit"] !== true) return;
        commits += 1;
        socket.send(
          JSON.stringify({
            message_type: "committed_transcript",
            text: commits === 1 ? "one" : "two",
          }),
        );
      });
    });

    const bus = new PipelineBusImpl();
    const started = bus.start();
    const plugin = new ElevenLabsSTTPlugin();
    const usage: UsageRecordedPacket[] = [];
    bus.on("usage.recorded", (pkt) => {
      usage.push(pkt as UsageRecordedPacket);
    });

    await plugin.initialize(bus, {
      api_key: "test",
      endpoint_url: endpointUrl,
      sample_rate: 16000,
      model: "scribe_v2_realtime",
      emit_eos_on_final: false,
    });
    // 320 + 320 = 0.01s + 0.01s
    bus.push(Route.Media, {
      kind: "stt.audio",
      contextId: "turn-multi",
      timestampMs: Date.now(),
      audio: new Uint8Array(320),
    });
    bus.push(Route.Main, { kind: "stt.finalize", contextId: "turn-multi", timestampMs: Date.now() });
    await waitFor(usage, 1);
    bus.push(Route.Media, {
      kind: "stt.audio",
      contextId: "turn-multi",
      timestampMs: Date.now(),
      audio: new Uint8Array(320),
    });
    bus.push(Route.Main, { kind: "stt.finalize", contextId: "turn-multi", timestampMs: Date.now() });
    await waitFor(usage, 2);

    const total = usage.reduce((sum, u) => sum + (u.audioSeconds ?? 0), 0);
    expect(total).toBeCloseTo(0.02, 6);
    expect(usage[0]?.audioSeconds).toBeCloseTo(0.01, 6);
    expect(usage[1]?.audioSeconds).toBeCloseTo(0.01, 6);

    await plugin.close();
    bus.stop();
    await started;
  });
});
