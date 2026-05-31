// SPDX-License-Identifier: MIT

import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer } from "ws";
import {
  rejectWebSocketAdmission,
  type TransportAdmissionOptions,
} from "./transport-host.js";

export interface RoutedWebSocketServer {
  readonly wsServer: WebSocketServer;
  readonly detach: () => void;
}

type UpgradeHandler = (
  request: IncomingMessage,
  socket: Socket,
  head: Buffer,
) => void;

interface HttpUpgradeRouter {
  readonly handlers: Map<string, UpgradeHandler>;
  readonly servers: Set<WebSocketServer>;
  readonly listener: (request: IncomingMessage, socket: Socket, head: Buffer) => void;
}

const routers = new WeakMap<HttpServer, HttpUpgradeRouter>();

function getOrCreateRouter(httpServer: HttpServer): HttpUpgradeRouter {
  const existing = routers.get(httpServer);
  if (existing) return existing;

  const handlers = new Map<string, UpgradeHandler>();
  const listener = (request: IncomingMessage, socket: Socket, head: Buffer): void => {
    const pathname = requestPathname(request);
    const handler = handlers.get(pathname);
    if (handler) {
      handler(request, socket, head);
      return;
    }
    socket.destroy();
  };
  httpServer.on("upgrade", listener);
  const router: HttpUpgradeRouter = { handlers, servers: new Set(), listener };
  routers.set(httpServer, router);
  return router;
}

function requestPathname(request: IncomingMessage): string {
  try {
    return new URL(request.url ?? "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
}

export function createRoutedWebSocketServer(
  httpServer: HttpServer,
  path: string,
  admission?: TransportAdmissionOptions,
): RoutedWebSocketServer {
  const wsServer = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
  });
  const router = getOrCreateRouter(httpServer);
  const handler: UpgradeHandler = (request, socket, head) => {
    const maxConcurrentSessions = admission?.maxConcurrentSessions;
    const scope = admission?.maxConcurrentSessionsScope ?? "path";
    const activeSessions = scope === "server"
      ? [...router.servers].reduce((sum, server) => sum + server.clients.size, 0)
      : wsServer.clients.size;
    if (
      maxConcurrentSessions !== undefined
      && activeSessions >= maxConcurrentSessions
    ) {
      admission?.onAdmissionRejected?.();
      rejectWebSocketAdmission(wsServer, request, socket, head);
      return;
    }
    wsServer.handleUpgrade(request, socket, head, (websocket) => {
      wsServer.emit("connection", websocket, request);
    });
  };
  router.handlers.set(path, handler);
  router.servers.add(wsServer);
  return {
    wsServer,
    detach: () => {
      router.handlers.delete(path);
      router.servers.delete(wsServer);
      if (router.handlers.size === 0) {
        httpServer.off("upgrade", router.listener);
        routers.delete(httpServer);
      }
    },
  };
}
