// SPDX-License-Identifier: MIT

import { WebSocket } from "ws";
import { closeWebSocketWithFallback } from "./websocket-close.js";

export function startWebSocketHeartbeat(
  socket: WebSocket,
  heartbeatIntervalMs: number,
  disposers: Array<() => void>,
): void {
  if (heartbeatIntervalMs <= 0) return;
  let alive = true;
  const onPong = () => {
    alive = true;
  };
  socket.on("pong", onPong);
  const interval = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (!alive) {
      socket.terminate();
      return;
    }
    alive = false;
    socket.ping();
  }, heartbeatIntervalMs);
  disposers.push(() => {
    clearInterval(interval);
    socket.off("pong", onPong);
  });
}

export function startWebSocketMaxSessionDuration(
  socket: WebSocket,
  maxSessionDurationMs: number,
  disposers: Array<() => void>,
  onTimeout?: () => void,
): void {
  if (maxSessionDurationMs <= 0) return;
  const timeout = setTimeout(() => {
    onTimeout?.();
    closeWebSocketWithFallback(socket, 1000, "websocket max session duration exceeded");
  }, maxSessionDurationMs);
  disposers.push(() => clearTimeout(timeout));
}
