// SPDX-License-Identifier: MIT
//
// Cloudflare Workers socket adapter. The built-in WebSocket constructor can't
// set request headers, so auth-header provider connections (Deepgram's
// `Authorization: Token`, Cartesia's `X-API-Key`) are opened with a `fetch`
// upgrade and the returned `response.webSocket`, then `accept()`-ed before use.
//
// Pattern from Cloudflare's own agents/voice package (workers-ai-providers.ts):
//   const resp = await fetch(url, { headers: { Upgrade: "websocket", ...auth } });
//   const ws = resp.webSocket; ws.accept();

import type { ManagedSocket } from "./index.js";
import { wrapWebSocket, type WebSocketLike } from "./web-socket.js";

/** The Workers WebSocket adds accept(); the upgrade response carries it. */
type WorkersWebSocket = WebSocketLike & { accept(): void };
interface UpgradeResponse {
  readonly status?: number;
  readonly webSocket?: WorkersWebSocket | null;
}
type WorkersFetch = (url: string, init: { headers: Record<string, string> }) => Promise<UpgradeResponse>;

export interface WorkersDurableObjectWebSocketContext {
  acceptWebSocket(socket: WorkersWebSocket): void;
}

export interface WorkersInboundSocket {
  readonly socket: ManagedSocket;
  readonly response: Response;
  readonly clientWebSocket: WorkersWebSocket;
  readonly serverWebSocket: WorkersWebSocket;
  readonly controller?: WorkersInboundSocketController;
}

export interface WorkersInboundSocketController {
  message(data: string | ArrayBuffer): void;
  close(code: number, reason: string): void;
  error(err?: Error): void;
}

type WebSocketPairValue = { 0: WorkersWebSocket; 1: WorkersWebSocket };
type WebSocketPairConstructor = new () => WebSocketPairValue;

/** Open an auth-header WebSocket from a Worker via fetch upgrade. Async — await before use. */
export async function createWorkersSocket(url: string, headers: Record<string, string>): Promise<ManagedSocket> {
  const doFetch = (globalThis as { fetch?: WorkersFetch }).fetch;
  if (!doFetch) throw new Error("fetch is not available in this runtime");
  // workerd's fetch() only accepts http(s) schemes; the upgrade is requested on
  // the http(s) URL with `Upgrade: websocket`, not on a ws(s):// URL.
  const resp = await doFetch(toHttpUrl(url), { headers: { ...headers, Upgrade: "websocket" } });
  const ws = resp.webSocket;
  if (!ws) throw new Error(`WebSocket upgrade failed (status ${String(resp.status ?? "unknown")})`);
  ws.accept();
  return wrapWebSocket(ws);
}

/** Normalize a ws(s):// provider URL to the http(s):// scheme workerd's fetch requires. */
function toHttpUrl(url: string): string {
  if (url.startsWith("wss://")) return `https://${url.slice("wss://".length)}`;
  if (url.startsWith("ws://")) return `http://${url.slice("ws://".length)}`;
  return url;
}

export function createWorkersInboundSocket(ctx?: WorkersDurableObjectWebSocketContext): WorkersInboundSocket {
  const Pair = (globalThis as { WebSocketPair?: WebSocketPairConstructor }).WebSocketPair;
  if (!Pair) throw new Error("WebSocketPair is not available in this runtime");
  const pair = new Pair();
  const client = pair[0];
  const server = pair[1];
  let controller: WorkersInboundSocketController | undefined;
  let socket: ManagedSocket;
  if (ctx) {
    ctx.acceptWebSocket(server);
    const controlled = createControlledSocket(server);
    socket = controlled.socket;
    controller = controlled.controller;
  } else {
    server.accept();
    socket = wrapWebSocket(server);
  }
  const response = new Response(null, {
    status: 101,
    webSocket: client,
  } as ResponseInit & { webSocket: WorkersWebSocket });
  return {
    socket,
    response,
    clientWebSocket: client,
    serverWebSocket: server,
    controller,
  };
}

function createControlledSocket(ws: WorkersWebSocket): {
  readonly socket: ManagedSocket;
  readonly controller: WorkersInboundSocketController;
} {
  const messageHandlers = new Set<(data: string | Uint8Array, isBinary: boolean) => void>();
  const closeHandlers = new Set<(code: number, reason: string) => void>();
  const errorHandlers = new Set<(err: Error) => void>();
  return {
    socket: {
      get isOpen(): boolean {
        return ws.readyState === 1;
      },
      send: (data) => ws.send(data),
      keepAlivePing: () => undefined,
      verify: async () => ws.readyState === 1,
      dispose: () => {
        try {
          ws.close();
        } catch {
          // best effort
        }
      },
      onOpen: (handler) => {
        if (ws.readyState === 1) queueMicrotask(handler);
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
          for (const handler of messageHandlers) handler(data, false);
          return;
        }
        const bytes = new Uint8Array(data);
        for (const handler of messageHandlers) handler(bytes, true);
      },
      close(code, reason) {
        for (const handler of closeHandlers) handler(code, reason);
      },
      error(err) {
        const error = err ?? new Error("WebSocket error");
        for (const handler of errorHandlers) handler(error);
      },
    },
  };
}
