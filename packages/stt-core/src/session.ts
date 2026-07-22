// SPDX-License-Identifier: MIT
//
// Ergonomic factory: wires a provider `SttWireProtocol` into a running streaming-STT
// session over a `WebSocketConnection`-backed transport, with standard PipelineBus wiring
// (stt.audio → send, stt.finalize → encodeFinalize, turn.change / interrupt.stt context
// bookkeeping). A provider's published `*STTPlugin` class delegates `initialize`/`close`
// to this — its public surface is unchanged.

import {
  Route,
  type AudioFormat,
  type PipelineBus,
  type RetryConfig,
  type SttReconfigurePartial,
} from "@kuralle-syrinx/core";
import { WebSocketConnection, type SocketData, type SocketFactory } from "@kuralle-syrinx/ws";

import { createSttEngine } from "./engine.js";
import type { SttWireProtocol } from "./types.js";

export interface StreamingSttSpec {
  readonly protocol: SttWireProtocol;
  readonly provider: { readonly name: string; readonly model: string; readonly region?: string };
  readonly url: () => string;
  readonly headers?: Record<string, string>;
  readonly retry: RetryConfig;
  readonly socketFactory: SocketFactory;
  readonly emitEosOnFinal?: boolean;
  readonly language?: string;
  readonly format?: AudioFormat;
  readonly maxReconnectAttempts?: number;
  readonly connectTimeoutMs?: number;
  readonly replayBufferSize?: number;
  readonly keepAliveIntervalMs?: number;
  readonly keepAliveMessage?: () => SocketData;
  readonly metricPrefix?: string;
}

export interface StreamingSttSession {
  dispose(): Promise<void>;
  reconfigure(partial: SttReconfigurePartial): void;
  reset(): void;
}

/** Open the provider socket, wire the bus, and return a handle whose `dispose()` tears it all down. */
export async function startStreamingSttSession(
  bus: PipelineBus,
  spec: StreamingSttSpec,
): Promise<StreamingSttSession> {
  let conn: WebSocketConnection;
  const metricPrefix = spec.metricPrefix ?? "stt";
  const protocol = spec.protocol;
  const engine = createSttEngine({
    protocol,
    transport: {
      ensureReady: () => conn.ensureReady(),
      send: (frame) => conn.send(frame),
      close: () => conn.close(),
      get isReady() {
        return conn.isReady;
      },
      reset: () => {
        conn.reset();
      },
    },
    sink: { push: (route, packet) => bus.push(route, packet as Parameters<PipelineBus["push"]>[1]) },
    provider: spec.provider,
    emitEosOnFinal: spec.emitEosOnFinal ?? true,
    language: spec.language ?? "en",
    format: spec.format,
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
    onReadyBeforeReplay: () => {
      for (const frame of protocol.onOpen?.() ?? []) conn.send(frame);
    },
    onReplay: (event, count) =>
      bus.push(Route.Background, {
        kind: "metric.conversation",
        contextId: "",
        timestampMs: Date.now(),
        name: `${metricPrefix}.reconnect_replay_${event}`,
        value: String(count),
      }),
  });
  await conn.connect();

  const disposers: Array<() => void> = [
    // STT plugins consume `stt.audio` only — the canonical STT ingress. VoiceAgentSession
    // fans `user.audio_received` out to `stt.audio` (handleUserAudio), so subscribing to both
    // would double-send + double-bill every frame in a real session.
    bus.on("stt.audio", (pkt: unknown) => {
      const audioPkt = pkt as { audio: Uint8Array; contextId?: string };
      void engine.onAudio(audioPkt.audio, audioPkt.contextId);
    }),
    bus.on("stt.finalize", (pkt: unknown) => {
      const finalizePkt = pkt as { contextId?: string };
      void engine.onFinalize(finalizePkt.contextId);
    }),
    bus.on("turn.change", (pkt: unknown) => {
      engine.onTurnChange((pkt as { contextId: string }).contextId);
    }),
    bus.on("interrupt.stt", () => {
      engine.onInterrupt();
    }),
  ];

  return {
    dispose: async () => {
      for (const dispose of disposers.splice(0)) dispose();
      await engine.close();
    },
    reconfigure: (partial: SttReconfigurePartial) => {
      const frames = protocol.encodeReconfigure?.(partial) ?? [];
      if (frames.length === 0) return;
      for (const frame of frames) conn.send(frame);
    },
    reset: () => {
      conn.reset();
    },
  };
}

/** Default Node socket factory — lazily imported so the heavy `ws` dep only loads when used. */
export async function defaultNodeSocketFactory(): Promise<SocketFactory> {
  const mod = await import("@kuralle-syrinx/ws/node");
  return mod.createNodeWsSocket;
}
