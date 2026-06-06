// SPDX-License-Identifier: MIT
//
// Adapter for WebSocketConnection backed by the standard built-in WebSocket —
// the one available in the browser, Cloudflare Workers, and Bun (and Node 21+).
// It has no ping frame, so verify() falls back to readyState and keepalive must
// use an app-level message (keepAliveMessage). Headers cannot be set on the
// WebSocket constructor in the browser; on Workers, auth-header connections use
// the fetch-upgrade route — construct the socket yourself and pass it to
// wrapWebSocket.

import type { ManagedSocket, SocketData, SocketFactory } from "./index.js";

/** The subset of the standard WebSocket this adapter relies on (no DOM lib needed). */
export interface WebSocketLike {
  readyState: number;
  binaryType: string;
  send(data: string | ArrayBufferView | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: WebSocketEventLike) => void): void;
}

/** The event object a standard WebSocket hands its listeners (message: data; close: code/reason). */
export interface WebSocketEventLike {
  readonly data?: string | ArrayBuffer;
  readonly code?: number;
  readonly reason?: string;
}

const WEBSOCKET_OPEN = 1;

/** Factory using the runtime's global WebSocket (no auth headers — same-origin or token-in-URL). */
export const createWebSocketAdapter: SocketFactory = (url): ManagedSocket => {
  const ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (!ctor) throw new Error("global WebSocket is not available in this runtime");
  return wrapWebSocket(new ctor(url));
};

/** Wrap an already-constructed WebSocket (e.g. a Workers fetch-upgrade `response.webSocket`). */
export function wrapWebSocket(ws: WebSocketLike): ManagedSocket {
  ws.binaryType = "arraybuffer";
  return {
    get isOpen(): boolean {
      return ws.readyState === WEBSOCKET_OPEN;
    },
    send: (data: SocketData) => ws.send(data),
    keepAlivePing: () => {
      // The standard WebSocket has no ping frame — rely on keepAliveMessage.
    },
    verify: async (): Promise<boolean> => ws.readyState === WEBSOCKET_OPEN,
    dispose: () => {
      try {
        ws.close();
      } catch {
        // best effort
      }
    },
    onOpen: (handler) => {
      // workerd: after fetch-upgrade + WebSocket.accept(), readyState is already OPEN
      // and the runtime never emits an "open" event — only sockets that transition
      // from CONNECTING fire it. queueMicrotask preserves the async onOpen contract
      // WebSocketConnection expects without waiting for an event that won't come.
      if (ws.readyState === WEBSOCKET_OPEN) {
        queueMicrotask(handler);
        return;
      }
      ws.addEventListener("open", () => handler());
    },
    onMessage: (handler) =>
      ws.addEventListener("message", (event) => {
        const payload = event.data;
        if (typeof payload === "string") {
          handler(payload, false);
        } else if (payload) {
          handler(new Uint8Array(payload), true);
        }
      }),
    onClose: (handler) => ws.addEventListener("close", (event) => handler(event.code ?? 1006, event.reason ?? "")),
    onError: (handler) => ws.addEventListener("error", () => handler(new Error("WebSocket error"))),
  };
}
