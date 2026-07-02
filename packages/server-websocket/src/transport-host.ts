// SPDX-License-Identifier: MIT

import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { VoiceAgentSession } from "@kuralle-syrinx/core";
import {
  WebSocketStartupTimeoutError,
  startWebSocketHeartbeat,
  startWebSocketMaxSessionDuration,
  withWebSocketStartupTimeout,
} from "./websocket-lifecycle.js";
import { cloneRawData, rawDataByteLength } from "./transport-helpers.js";

interface PendingMessage {
  readonly data: RawData;
  readonly isBinary: boolean;
  readonly byteLength: number;
}

export interface TransportHostConfig {
  readonly heartbeatIntervalMs: number;
  readonly startupTimeoutMs: number;
  readonly maxSessionDurationMs: number;
  readonly maxBufferedAmountBytes: number;
  readonly maxInboundMessageBytes: number;
}

export interface TransportAdmissionOptions {
  readonly maxConcurrentSessions?: number;
  readonly maxConcurrentSessionsScope?: "path" | "server";
  readonly onAdmissionRejected?: () => void;
  /**
   * Authorize an inbound connection before the WebSocket upgrade completes. Return
   * false (or throw) to reject with 4401. Voice endpoints are unauthenticated by
   * default and each connection incurs provider cost and can attach to a live
   * session — set this (shared secret / bearer / Twilio signature) before exposing
   * the endpoint. Receives the raw upgrade request (headers + URL) so it can read
   * an `Authorization` header or a `?token=` query param.
   */
  readonly authorize?: (request: IncomingMessage) => boolean | Promise<boolean>;
}

export const TRANSPORT_ADMISSION_REJECTED_METRIC = "transport.admission_rejected";

export function rejectWebSocketAdmission(
  wsServer: WebSocketServer,
  request: IncomingMessage,
  socket: Socket,
  head: Buffer,
  code = 1013,
  reason = "try again later",
): void {
  wsServer.handleUpgrade(request, socket, head, (websocket) => {
    websocket.close(code, reason);
  });
}

export interface GracefulCloseOptions {
  readonly graceful?: boolean;
  readonly drainDeadlineMs?: number;
}

export interface TransportAdapter<TState> {
  createState(): TState;

  acquireSession(args: {
    readonly request: IncomingMessage;
    readonly state: TState;
    readonly shouldAbort: () => boolean;
    readonly onSessionCreated: (session: VoiceAgentSession) => void;
  }): Promise<{ readonly session: VoiceAgentSession; readonly resumed: boolean }>;

  wireSession(
    session: VoiceAgentSession,
    socket: WebSocket,
    state: TState,
    disposers: Array<() => void>,
  ): (reason: string) => void;

  processMessage(
    data: RawData,
    isBinary: boolean,
    session: VoiceAgentSession,
    state: TState,
  ): void;

  onSocketClose?(state: TState, session: VoiceAgentSession | null): void;

  onDisconnect(
    session: VoiceAgentSession,
    state: TState,
    opts: { readonly maxSessionTimedOut: boolean },
  ): void;

  onStartupTimeout(state: TState, session: VoiceAgentSession): void;

  sendReady?(
    session: VoiceAgentSession,
    socket: WebSocket,
    state: TState,
    resumed: boolean,
    config: TransportHostConfig,
  ): void;

  sendError(socket: WebSocket, state: TState, message: string): void;

  sendStartupError(socket: WebSocket, state: TState, err: unknown, isTimeout: boolean): void;

  onMaxSessionTimeout?(socket: WebSocket, state: TState): void;
}

export async function runWebSocketConnection<TState>(
  socket: WebSocket,
  request: IncomingMessage,
  config: TransportHostConfig,
  adapter: TransportAdapter<TState>,
): Promise<void> {
  const state = adapter.createState();
  const disposers: Array<() => void> = [];
  const pendingMessages: PendingMessage[] = [];
  let pendingMessageBytes = 0;
  let ready = false;
  let socketClosed = socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING;
  if (socketClosed) {
    return;
  }
  let maxSessionTimedOut = false;
  let startupTimedOut = false;
  let teardown: (reason: string) => void = () => undefined;
  let session: VoiceAgentSession | null = null;
  const startupSession: { current?: VoiceAgentSession } = {};

  const processMessage = (data: RawData, isBinary: boolean): void => {
    if (!session) return;
    adapter.processMessage(data, isBinary, session, state);
  };

  const handleMessage = (data: RawData, isBinary: boolean): void => {
    try {
      const byteLength = rawDataByteLength(data);
      if (byteLength > config.maxInboundMessageBytes) {
        adapter.sendError(
          socket,
          state,
          `Websocket message exceeds maxInboundMessageBytes (${String(config.maxInboundMessageBytes)})`,
        );
        socket.close(1009, "websocket message too large");
        return;
      }
      if (!ready) {
        pendingMessageBytes += byteLength;
        if (pendingMessageBytes > config.maxInboundMessageBytes) {
          adapter.sendError(
            socket,
            state,
            `Pending websocket input exceeds maxInboundMessageBytes (${String(config.maxInboundMessageBytes)}) before session ready`,
          );
          socket.close(1009, "websocket pending input too large");
          return;
        }
        pendingMessages.push({ data: cloneRawData(data), isBinary, byteLength });
        return;
      }
      processMessage(data, isBinary);
    } catch (err) {
      adapter.sendError(socket, state, err instanceof Error ? err.message : String(err));
    }
  };

  socket.on("message", handleMessage);

  socket.on("close", () => {
    socketClosed = true;
    adapter.onSocketClose?.(state, session);
    teardown("disconnect");
    for (const dispose of disposers.splice(0)) dispose();
    if (session) {
      adapter.onDisconnect(session, state, { maxSessionTimedOut });
    }
  });

  try {
    const startup = adapter.acquireSession({
      request,
      state,
      shouldAbort: () => socketClosed || startupTimedOut,
      onSessionCreated: (s) => { startupSession.current = s; },
    });
    startup.catch(() => undefined);
    const acquired = await withWebSocketStartupTimeout(startup, config.startupTimeoutMs);
    session = acquired.session;
    if (socketClosed) {
      adapter.onDisconnect(session, state, { maxSessionTimedOut });
      return;
    }
    startWebSocketHeartbeat(socket, config.heartbeatIntervalMs, disposers);
    startWebSocketMaxSessionDuration(socket, config.maxSessionDurationMs, disposers, () => {
      maxSessionTimedOut = true;
      adapter.onMaxSessionTimeout?.(socket, state);
    });
    teardown = adapter.wireSession(session, socket, state, disposers);
    adapter.sendReady?.(session, socket, state, acquired.resumed, config);
    ready = true;
    for (const pending of pendingMessages.splice(0)) {
      pendingMessageBytes -= pending.byteLength;
      try {
        processMessage(pending.data, pending.isBinary);
      } catch (err) {
        adapter.sendError(socket, state, err instanceof Error ? err.message : String(err));
      }
    }
    pendingMessageBytes = 0;
  } catch (err) {
    if (err instanceof WebSocketStartupTimeoutError) {
      startupTimedOut = true;
      if (startupSession.current) {
        adapter.onStartupTimeout(state, startupSession.current);
      }
    }
    adapter.sendStartupError(socket, state, err, err instanceof WebSocketStartupTimeoutError);
    socket.close(1011, "session initialization failed");
  }
}
