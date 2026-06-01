// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import {
  PipelineBusImpl,
  Route,
  type ConversationMetricPacket,
  type EndOfSpeechPacket,
} from "@asyncdot/voice";
import { DeepgramSTTPlugin } from "@asyncdot/voice-stt-deepgram";
import { PipecatEOSPlugin, type SmartTurnPredictor } from "@asyncdot/voice-turn-pipecat";

class PredictableSmartTurn implements SmartTurnPredictor {
  constructor(private readonly predictions: number[]) {}

  async initialize(): Promise<void> {
    // no-op
  }

  async predict(): Promise<number> {
    return this.predictions.shift() ?? 0.9;
  }

  async close(): Promise<void> {
    // no-op
  }
}

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

async function createLocalDeepgramServer(onConnection: (socket: WebSocket) => void): Promise<string> {
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

describe("turn finalization root fix replay", () => {
  it("keeps a short restarted utterance as one semantic turn without provider finalize timeout", async () => {
    const transcripts = [
      "I need to know",
      "whether the petition is approved.",
    ];
    const endpointUrl = await createLocalDeepgramServer((socket) => {
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          const transcript = transcripts.shift();
          if (!transcript) return;
          socket.send(JSON.stringify({
            is_final: true,
            speech_final: false,
            channel: { alternatives: [{ transcript, confidence: 0.92 }] },
          }));
          return;
        }
        const msg = JSON.parse(data.toString()) as { type?: string };
        if (msg.type !== "Finalize") return;
        socket.send(JSON.stringify({
          is_final: true,
          speech_final: false,
          from_finalize: true,
          channel: { alternatives: [{ transcript: "whether the petition is approved.", confidence: 0.94 }] },
        }));
      });
    });
    const bus = new PipelineBusImpl();
    const started = startBus(bus);
    const stt = new DeepgramSTTPlugin();
    const eos = new PipecatEOSPlugin(new PredictableSmartTurn([0.9, 0.9]));
    const completions: EndOfSpeechPacket[] = [];
    const metrics: ConversationMetricPacket[] = [];
    bus.on("eos.turn_complete", (pkt) => { completions.push(pkt as EndOfSpeechPacket); });
    bus.on("metric.conversation", (pkt) => { metrics.push(pkt as ConversationMetricPacket); });

    await stt.initialize(bus, {
      api_key: "test",
      endpoint_url: endpointUrl,
      sample_rate: 16000,
      emit_eos_on_final: false,
      finalize_on_speech_final: false,
      provider_finalize_timeout_ms: 20,
      finalize_timeout_fallback: true,
    });
    await eos.initialize(bus, {
      finalize_delay_ms: 5,
      max_delay_ms: 0,
      semantic_defer_fallback_ms: 100,
      incomplete_fallback_ms: 100,
    });

    bus.push(Route.Main, { kind: "vad.speech_started", contextId: "semantic-turn", timestampMs: Date.now(), confidence: 0.9 });
    bus.push(Route.Main, { kind: "stt.audio", contextId: "semantic-turn", timestampMs: Date.now(), audio: new Uint8Array(640) });
    await new Promise((resolve) => setTimeout(resolve, 10));
    bus.push(Route.Main, { kind: "vad.speech_ended", contextId: "semantic-turn", timestampMs: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 20));

    bus.push(Route.Main, { kind: "vad.speech_started", contextId: "semantic-turn", timestampMs: Date.now(), confidence: 0.9 });
    bus.push(Route.Main, { kind: "stt.audio", contextId: "semantic-turn", timestampMs: Date.now(), audio: new Uint8Array(640) });
    await new Promise((resolve) => setTimeout(resolve, 10));
    bus.push(Route.Main, { kind: "vad.speech_ended", contextId: "semantic-turn", timestampMs: Date.now() });

    await waitFor(completions);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(completions).toEqual([
      expect.objectContaining({
        kind: "eos.turn_complete",
        contextId: "semantic-turn",
        text: "I need to know whether the petition is approved.",
      }),
    ]);
    expect(metrics).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "stt_provider_finalize_timeout" }),
      expect.objectContaining({ name: "stt_provider_finalize_timeout_fallback" }),
    ]));

    await eos.close();
    await stt.close();
    bus.stop();
    await started;
  });
});
