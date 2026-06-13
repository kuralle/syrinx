// SPDX-License-Identifier: MIT

import type { ManagedSocket, SocketData } from "@kuralle-syrinx/ws";

/**
 * The subset of the `agents` SDK `Connection` (itself a WebSocket) that the
 * voice bridge drives. Kept structural so the package never has to import the
 * full `Connection` type at runtime — the mixin passes the real Connection in.
 */
export interface VoiceConnection {
  readonly id: string;
  readonly readyState: number;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

/**
 * Pumps the Agent's per-connection lifecycle callbacks into the `ManagedSocket`.
 * The mixin feeds this from its patched `onMessage` / `onClose` hooks.
 */
export interface ConnectionSocketController {
  message(data: string | ArrayBuffer): void;
  close(code: number, reason: string): void;
  error(err?: Error): void;
}

const WEBSOCKET_OPEN = 1;

/**
 * Wrap an `agents` `Connection` as a Syrinx `ManagedSocket`.
 *
 * The Agent base delivers inbound frames through its `onMessage(connection, …)`
 * hook — which keeps working across Durable Object hibernation, unlike attaching
 * raw `addEventListener` handlers to the socket (the trap that forces
 * `static options = { hibernate: false }` in the OpenAI/Twilio examples). So this
 * socket is *externally pumped*: the mixin forwards lifecycle events to the
 * returned controller, and the controller fans them out to the handlers
 * `runVoiceEdgeWebSocketConnection` registers.
 *
 * Mirrors the DO-owned controlled socket in `@kuralle-syrinx/ws/workers`, but the
 * Agent has already accepted the connection, so there is no `WebSocketPair` to
 * create or `accept()` to call here.
 */
export function connectionManagedSocket(connection: VoiceConnection): {
  readonly socket: ManagedSocket;
  readonly controller: ConnectionSocketController;
} {
  const messageHandlers = new Set<(data: SocketData, isBinary: boolean) => void>();
  const closeHandlers = new Set<(code: number, reason: string) => void>();
  const errorHandlers = new Set<(err: Error) => void>();
  let closed = false;

  // Fire the close handlers exactly once, whether the close was initiated by the
  // client (pumped via controller.close from the Agent's onClose hook) or by the
  // edge runner / mixin calling socket.dispose(). The edge runner registers its
  // teardown (recorder finalize, session-lease release) as a close handler, so it
  // must run on a dispose() too — not only when the platform happens to deliver a
  // server-initiated onClose. Iterate a copy so a handler may deregister safely.
  const fireClose = (code: number, reason: string): void => {
    if (closed) return;
    closed = true;
    for (const handler of [...closeHandlers]) handler(code, reason);
  };

  return {
    socket: {
      get isOpen(): boolean {
        return !closed && connection.readyState === WEBSOCKET_OPEN;
      },
      send: (data) => connection.send(data),
      keepAlivePing: () => undefined,
      verify: async () => !closed && connection.readyState === WEBSOCKET_OPEN,
      dispose: () => {
        fireClose(1006, "disposed");
        try {
          connection.close();
        } catch {
          /* already closing */
        }
      },
      onOpen: (handler) => {
        // The connection is already open by the time the mixin wraps it.
        if (connection.readyState === WEBSOCKET_OPEN) queueMicrotask(handler);
      },
      onMessage: (handler) => {
        messageHandlers.add(handler);
      },
      onClose: (handler) => {
        closeHandlers.add(handler);
      },
      onError: (handler) => {
        errorHandlers.add(handler);
      },
    },
    controller: {
      message(data) {
        if (typeof data === "string") {
          for (const handler of [...messageHandlers]) handler(data, false);
          return;
        }
        const bytes = new Uint8Array(data);
        for (const handler of [...messageHandlers]) handler(bytes, true);
      },
      close(code, reason) {
        fireClose(code, reason);
      },
      error(err) {
        const error = err ?? new Error("WebSocket error");
        for (const handler of [...errorHandlers]) handler(error);
      },
    },
  };
}
