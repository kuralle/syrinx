// SPDX-License-Identifier: MIT
//
// Node/Bun socket adapter for WebSocketConnection, backed by the `ws` library.
// Kept in its own entry point so a Cloudflare Workers build (which uses
// createWebSocketAdapter) never bundles `ws`.

import WebSocket, { type RawData } from "ws";
import type { ManagedSocket, SocketData, SocketFactory } from "./index.js";

export const createNodeWsSocket: SocketFactory = (url, headers): ManagedSocket => {
  const ws = new WebSocket(url, Object.keys(headers).length > 0 ? { headers } : undefined);
  let verifyTimer: ReturnType<typeof setTimeout> | null = null;
  let verifyOnPong: (() => void) | null = null;
  let verifyResolve: ((value: boolean) => void) | null = null;

  const clearVerify = (result?: boolean): void => {
    if (verifyTimer) clearTimeout(verifyTimer);
    if (verifyOnPong) ws.off("pong", verifyOnPong);
    verifyTimer = null;
    verifyOnPong = null;
    if (verifyResolve) {
      verifyResolve(result ?? false);
      verifyResolve = null;
    }
  };

  return {
    get isOpen(): boolean {
      return ws.readyState === ws.OPEN;
    },
    send: (data: SocketData) => ws.send(data),
    keepAlivePing: () => {
      try {
        ws.ping();
      } catch {
        // socket not open — keepalive is best-effort
      }
    },
    verify: (timeoutMs: number) =>
      new Promise<boolean>((resolve) => {
        clearVerify(false);
        if (ws.readyState !== ws.OPEN) {
          resolve(false);
          return;
        }
        verifyResolve = resolve;
        const onPong = (): void => {
          clearVerify(true);
        };
        verifyOnPong = onPong;
        verifyTimer = setTimeout(() => {
          clearVerify(false);
        }, timeoutMs);
        ws.once("pong", onPong);
        try {
          ws.ping();
        } catch {
          clearVerify(false);
        }
      }),
    dispose: () => {
      clearVerify(false);
      ws.removeAllListeners();
      // Closing a socket that is still CONNECTING makes `ws` emit an asynchronous
      // 'error' event ("WebSocket was closed before the connection was established").
      // removeAllListeners() just stripped the error handler, so without re-attaching
      // a sink that event becomes an uncaught exception and crashes the process — the
      // exact thing that happens when a caller hangs up during a slow provider connect.
      // Swallow stray close-time errors, and abort a pending handshake with terminate().
      ws.on("error", () => {});
      try {
        if (ws.readyState === ws.CONNECTING) {
          ws.terminate();
        } else {
          ws.close();
        }
      } catch {
        // best effort
      }
    },
    onOpen: (handler) => ws.on("open", handler),
    onMessage: (handler) =>
      ws.on("message", (data: RawData, isBinary: boolean) =>
        handler(isBinary ? toUint8(data) : data.toString(), isBinary),
      ),
    onClose: (handler) => ws.on("close", (code: number, reason: Buffer) => handler(code, reason.toString("utf8"))),
    onError: (handler) => ws.on("error", handler),
  };
};

function toUint8(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
