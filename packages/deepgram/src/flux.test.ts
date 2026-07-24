// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import {
  PipelineBusImpl,
  Route,
  type EndOfSpeechPacket,
  type EndOfSpeechRetractedPacket,
  type InterimEndOfSpeechPacket,
  type SttInterimPacket,
  type SttResultPacket,
  type UsageRecordedPacket,
} from "@kuralle-syrinx/core";

import { DeepgramFluxSTTPlugin } from "./flux.js";

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

interface LocalServer {
  endpointUrl: string;
  connectionUrls: string[];
  sockets: WebSocket[];
}

async function createLocalServer(): Promise<LocalServer> {
  const server = await new Promise<WebSocketServer>((resolve) => {
    let nextServer: WebSocketServer;
    nextServer = new WebSocketServer({ port: 0 }, () => resolve(nextServer));
  });
  servers.push(server);
  const state: LocalServer = { endpointUrl: "", connectionUrls: [], sockets: [] };
  server.on("connection", (socket, req) => {
    state.connectionUrls.push(req.url ?? "");
    state.sockets.push(socket);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address");
  state.endpointUrl = `ws://127.0.0.1:${address.port}/v2/listen`;
  return state;
}

async function waitFor<T>(items: T[], count = 1): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (items.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function turnInfo(event: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "TurnInfo",
    event,
    turn_index: 0,
    audio_window_start: 0,
    audio_window_end: 0.6,
    transcript: "",
    words: [],
    end_of_turn_confidence: 0.5,
    ...extra,
  });
}

async function startPlugin(
  local: LocalServer,
  config: Record<string, unknown> = {},
): Promise<{ bus: PipelineBusImpl; plugin: DeepgramFluxSTTPlugin; started: Promise<void> }> {
  const bus = new PipelineBusImpl();
  const started = bus.start();
  const plugin = new DeepgramFluxSTTPlugin();
  await plugin.initialize(bus, {
    api_key: "test",
    endpoint_url: local.endpointUrl,
    sample_rate: 16000,
    ...config,
  });
  await waitFor(local.sockets);
  // Feed one audio packet so the plugin learns the current contextId.
  bus.push(Route.Main, {
    kind: "stt.audio",
    contextId: "turn-1",
    timestampMs: Date.now(),
    audio: new Uint8Array(320),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { bus, plugin, started };
}

describe("DeepgramFluxSTTPlugin", () => {
  it("connects with Flux params and forwards keyterm + eager threshold", async () => {
    const local = await createLocalServer();
    const { bus, plugin, started } = await startPlugin(local, {
      eot_threshold: 0.85,
      eager_eot_threshold: 0.4,
      eot_timeout_ms: 7000,
      keyterm: ["Syrinx"],
    });

    await plugin.close();
    bus.stop();
    await started;

    const url = local.connectionUrls[0]!;
    expect(url).toContain("model=flux-general-en");
    expect(url).toContain("encoding=linear16");
    expect(url).toContain("sample_rate=16000");
    expect(url).toContain("eot_threshold=0.85");
    expect(url).toContain("eager_eot_threshold=0.4");
    expect(url).toContain("eot_timeout_ms=7000");
    expect(url).toContain("keyterm=Syrinx");
  });

  it("reconfigure sends a Flux Configure control message with only the supplied fields", async () => {
    const local = await createLocalServer();
    const { bus, plugin, started } = await startPlugin(local, { keyterm: ["Syrinx"] });
    const received: string[] = [];
    local.sockets[0]!.on("message", (data, isBinary) => {
      if (!isBinary) received.push(data.toString());
    });

    plugin.reconfigure({ keyterms: ["account number", "Syrinx"], eotThreshold: 0.85, eotTimeoutMs: 3000 });
    await waitFor(received);

    await plugin.close();
    bus.stop();
    await started;

    expect(received).toHaveLength(1);
    expect(JSON.parse(received[0]!)).toEqual({
      type: "Configure",
      thresholds: { eot_threshold: 0.85, eot_timeout_ms: 3000 },
      keyterms: ["account number", "Syrinx"],
    });
  });

  it("surfaces ConfigureSuccess / ConfigureFailure acks as metrics", async () => {
    const local = await createLocalServer();
    const { bus, plugin, started } = await startPlugin(local);
    const metrics: string[] = [];
    bus.on("metric.conversation", (pkt) => {
      metrics.push((pkt as unknown as { name: string }).name);
    });

    local.sockets[0]!.send(JSON.stringify({ type: "ConfigureSuccess", keyterms: ["account number"] }));
    await waitFor(metrics);
    local.sockets[0]!.send(JSON.stringify({ type: "ConfigureFailure", code: "INVALID_THRESHOLD", description: "bad" }));
    await waitFor(metrics, 2);

    await plugin.close();
    bus.stop();
    await started;

    expect(metrics).toContain("stt.flux.configure_success");
    expect(metrics).toContain("stt.flux.configure_failure");
  });

  it("omits eager_eot_threshold by default (eager mode is opt-in)", async () => {
    const local = await createLocalServer();
    const { bus, plugin, started } = await startPlugin(local);

    await plugin.close();
    bus.stop();
    await started;

    const url = local.connectionUrls[0]!;
    expect(url).toContain("eot_threshold=0.7");
    expect(url).not.toContain("eager_eot_threshold=");
  });

  it("maps TurnInfo events onto the bus: Update→stt.interim, EndOfTurn→stt.result+eos.turn_complete", async () => {
    const local = await createLocalServer();
    const { bus, plugin, started } = await startPlugin(local);

    const interims: SttInterimPacket[] = [];
    const results: SttResultPacket[] = [];
    const turnCompletes: EndOfSpeechPacket[] = [];
    bus.on("stt.interim", (pkt) => {
      interims.push(pkt as SttInterimPacket);
    });
    bus.on("stt.result", (pkt) => {
      results.push(pkt as SttResultPacket);
    });
    bus.on("eos.turn_complete", (pkt) => {
      turnCompletes.push(pkt as EndOfSpeechPacket);
    });

    const socket = local.sockets[0]!;
    socket.send(turnInfo("Update", { transcript: "what are" }));
    socket.send(
      turnInfo("EndOfTurn", {
        transcript: "what are the lab fees",
        words: [
          { word: "what", confidence: 0.99 },
          { word: "are", confidence: 0.97 },
        ],
        end_of_turn_confidence: 0.91,
      }),
    );
    await waitFor(turnCompletes);

    await plugin.close();
    bus.stop();
    await started;

    expect(interims.map((p) => p.text)).toContain("what are");
    expect(results).toHaveLength(1);
    expect(results[0]!.text).toBe("what are the lab fees");
    expect(results[0]!.confidence).toBeCloseTo(0.98, 2);
    expect(turnCompletes).toEqual([
      expect.objectContaining({ contextId: "turn-1", text: "what are the lab fees" }),
    ]);
  });

  it("emits eos.interim on EagerEndOfTurn and eos.retracted on TurnResumed", async () => {
    const local = await createLocalServer();
    const { bus, plugin, started } = await startPlugin(local, { eager_eot_threshold: 0.4 });

    const eagers: InterimEndOfSpeechPacket[] = [];
    const retractions: EndOfSpeechRetractedPacket[] = [];
    bus.on("eos.interim", (pkt) => {
      eagers.push(pkt as InterimEndOfSpeechPacket);
    });
    bus.on("eos.retracted", (pkt) => {
      retractions.push(pkt as EndOfSpeechRetractedPacket);
    });

    const socket = local.sockets[0]!;
    socket.send(turnInfo("EagerEndOfTurn", { transcript: "book a room", end_of_turn_confidence: 0.55 }));
    await waitFor(eagers);
    socket.send(turnInfo("TurnResumed"));
    await waitFor(retractions);

    await plugin.close();
    bus.stop();
    await started;

    expect(eagers).toEqual([expect.objectContaining({ contextId: "turn-1", text: "book a room" })]);
    expect(retractions).toEqual([expect.objectContaining({ contextId: "turn-1" })]);
  });

  it("emits vad.speech_started on StartOfTurn (Flux owns barge-in signalling)", async () => {
    const local = await createLocalServer();
    const { bus, plugin, started } = await startPlugin(local);

    const speechStarts: unknown[] = [];
    bus.on("vad.speech_started", (pkt) => {
      speechStarts.push(pkt);
    });

    const socket = local.sockets[0]!;
    socket.send(turnInfo("StartOfTurn", { transcript: "hello" }));
    await waitFor(speechStarts);

    await plugin.close();
    bus.stop();
    await started;

    expect(speechStarts.length).toBe(1);
  });

  it("emits usage.recorded with stage stt and audioSeconds on EndOfTurn", async () => {
    const local = await createLocalServer();
    const { bus, plugin, started } = await startPlugin(local);
    // startPlugin already sent 320 bytes @ 16kHz → 320/2/16000 = 0.01 s

    const usage: UsageRecordedPacket[] = [];
    bus.on("usage.recorded", (pkt) => {
      usage.push(pkt as UsageRecordedPacket);
    });

    const socket = local.sockets[0]!;
    socket.send(
      turnInfo("EndOfTurn", {
        transcript: "hello flux",
        words: [{ word: "hello", confidence: 0.9 }],
      }),
    );
    await waitFor(usage);

    await plugin.close();
    bus.stop();
    await started;

    expect(usage).toEqual([
      expect.objectContaining({
        kind: "usage.recorded",
        contextId: "turn-1",
        stage: "stt",
        provider: "deepgram",
        model: "flux-general-en",
        audioSeconds: 0.01,
      }),
    ]);
  });

  it("defaults encoding=linear16 and allows encoding override", async () => {
    const local = await createLocalServer();
    const { bus, plugin, started } = await startPlugin(local, {
      encoding: "mulaw",
    });

    await plugin.close();
    bus.stop();
    await started;

    expect(local.connectionUrls[0]!).toContain("encoding=mulaw");
  });

  it("merges query_params into the Flux listen URL", async () => {
    const local = await createLocalServer();
    const { bus, plugin, started } = await startPlugin(local, {
      query_params: {
        profanity_filter: true,
        tag: "flux-prod",
      },
    });

    await plugin.close();
    bus.stop();
    await started;

    const url = local.connectionUrls[0]!;
    expect(url).toContain("encoding=linear16");
    expect(url).toContain("eot_threshold=0.7");
    expect(url).toContain("profanity_filter=true");
    expect(url).toContain("tag=flux-prod");
  });

  it("forwards language_hint as a repeatable query param", async () => {
    const local = await createLocalServer();
    const { bus, plugin, started } = await startPlugin(local, {
      language_hint: ["en", "es"],
    });

    await plugin.close();
    bus.stop();
    await started;

    const url = local.connectionUrls[0]!;
    expect(url).toContain("language_hint=en");
    expect(url).toContain("language_hint=es");
  });
});
