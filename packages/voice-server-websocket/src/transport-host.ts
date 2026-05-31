// SPDX-License-Identifier: MIT

import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { VoiceAgentSession } from "@asyncdot/voice";
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
}

export const TRANSPORT_ADMISSION_REJECTED_METRIC = "transport.admission_rejected";

export function rejectWebSocketAdmission(
  wsServer: WebSocketServer,
  request: IncomingMessage,
  socket: Socket,
  head: Buffer,
): void {
  wsServer.handleUpgrade(request, socket, head, (websocket) => {
    websocket.close(1013, "try again later");
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
  let socketClosed = false;
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
