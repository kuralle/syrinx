// SPDX-License-Identifier: MIT

import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer } from "ws";

export interface RoutedWebSocketServer {
  readonly wsServer: WebSocketServer;
  readonly detach: () => void;
}

export function createRoutedWebSocketServer(httpServer: HttpServer, path: string): RoutedWebSocketServer {
  const wsServer = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
  });
  const onUpgrade = (request: IncomingMessage, socket: Socket, head: Buffer) => {
    if (!requestMatchesPath(request, path)) return;
    wsServer.handleUpgrade(request, socket, head, (websocket) => {
      wsServer.emit("connection", websocket, request);
    });
  };
  httpServer.on("upgrade", onUpgrade);
  return {
    wsServer,
    detach: () => httpServer.off("upgrade", onUpgrade),
  };
}

function requestMatchesPath(request: IncomingMessage, expectedPath: string): boolean {
  const url = new URL(request.url ?? "/", "http://localhost");
  return url.pathname === expectedPath;
}
