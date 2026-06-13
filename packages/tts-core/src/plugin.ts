// SPDX-License-Identifier: MIT
//
// Ergonomic factory: wires a provider `WireProtocol` into a running streaming-TTS session
// over a `WebSocketConnection`-backed transport, with the standard PipelineBus wiring
// (tts.text→onText / tts.done→onDone / interrupt.tts→onInterrupt). A provider's published
// `*TTSPlugin` class delegates `initialize`/`close` to this — its public surface is unchanged.

import { Route, type AudioFormat, type PipelineBus, type RetryConfig } from "@kuralle-syrinx/core";
import { WebSocketConnection, type SocketData, type SocketFactory } from "@kuralle-syrinx/ws";

import { createTtsEngine } from "./engine.js";
import type { WireProtocol } from "./types.js";

export interface StreamingTtsSpec {
  readonly protocol: WireProtocol;
  readonly provider: { readonly name: string; readonly model: string; readonly region?: string };
  readonly format: AudioFormat;
  readonly sampleRateHz: number;
  readonly url: () => string;
  readonly headers?: Record<string, string>;
  readonly retry: RetryConfig;
  readonly finishTimeoutMs: number;
  readonly metricPrefix: string;
  /** Emit `${metricPrefix}.reconnect_replay_*` metrics on replay activity (opt-in per provider). */
  readonly replayMetrics?: boolean;
  readonly socketFactory: SocketFactory;
  readonly maxReconnectAttempts?: number;
  readonly connectTimeoutMs?: number;
  readonly replayBufferSize?: number;
  readonly keepAliveIntervalMs?: number;
  readonly keepAliveMessage?: () => SocketData;
}

export interface StreamingTtsSession {
  dispose(): Promise<void>;
}

/** Open the provider socket, wire the bus, and return a handle whose `dispose()` tears it all down. */
export async function startStreamingTtsSession(
  bus: PipelineBus,
  spec: StreamingTtsSpec,
): Promise<StreamingTtsSession> {
  let conn: WebSocketConnection;
  const engine = createTtsEngine({
    protocol: spec.protocol,
    transport: {
      ensureReady: () => conn.ensureReady(),
      send: (frame) => conn.send(frame),
      close: () => conn.close(),
    },
    sink: { push: (route, packet) => bus.push(route, packet as Parameters<PipelineBus["push"]>[1]) },
    format: spec.format,
    sampleRateHz: spec.sampleRateHz,
    provider: spec.provider,
    finishTimeoutMs: spec.finishTimeoutMs,
    metricPrefix: spec.metricPrefix,
  });

  conn = new WebSocketConnection({
    url: spec.url,
    headers: spec.headers,
    socketFactory: spec.socketFactory,
    retry: spec.retry,
    maxReconnectAttempts: spec.maxReconnectAttempts,
    connectTimeoutMs: spec.connectTimeoutMs,
    replayBufferSize: spec.replayBufferSize,
    keepAliveIntervalMs: spec.keepAliveIntervalMs,
    keepAliveMessage: spec.keepAliveMessage,
    onMessage: (data, isBinary) => engine.onMessage(data, isBinary),
    onConnectionLost: (err) => engine.onConnectionLost(err),
    onUnrecoverable: (err) => engine.onConnectionLost(err),
    onReplay: spec.replayMetrics
      ? (event, count) =>
          bus.push(Route.Background, {
            kind: "metric.conversation",
            contextId: "",
            timestampMs: Date.now(),
            name: `${spec.metricPrefix}.reconnect_replay_${event}`,
            value: String(count),
          })
      : undefined,
  });
  await conn.connect();

  const disposers: Array<() => void> = [
    bus.on("tts.text", async (pkt: unknown) => {
      const textPkt = pkt as { text: string; contextId: string };
      await engine.onText(textPkt.text, textPkt.contextId);
    }),
    bus.on("tts.done", async (pkt: unknown) => {
      const donePkt = pkt as { contextId: string };
      await engine.onDone(donePkt.contextId);
    }),
    bus.on("interrupt.tts", () => {
      engine.onInterrupt().catch(() => {
        // Best-effort interruption.
      });
    }),
  ];

  return {
    dispose: async () => {
      for (const dispose of disposers.splice(0)) dispose();
      await engine.close();
    },
  };
}

/** Default Node socket factory — lazily imported so the heavy `ws` dep only loads when used. */
export async function defaultNodeSocketFactory(): Promise<SocketFactory> {
  const mod = await import("@kuralle-syrinx/ws/node");
  return mod.createNodeWsSocket;
}
