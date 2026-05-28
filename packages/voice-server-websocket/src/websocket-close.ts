// SPDX-License-Identifier: MIT

import { WebSocket } from "ws";

const DEFAULT_TERMINATE_AFTER_MS = 250;

export function closeWebSocketWithFallback(
  socket: WebSocket,
  code: number,
  reason: string,
  terminateAfterMs = DEFAULT_TERMINATE_AFTER_MS,
): void {
  if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) return;

  socket.close(code, reason);
  const timer = setTimeout(() => {
    if (socket.readyState !== WebSocket.CLOSED) {
      socket.terminate();
    }
  }, terminateAfterMs);
  timer.unref?.();
  socket.once("close", () => {
    clearTimeout(timer);
  });
}
