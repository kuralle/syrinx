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

/**
 * Serialize `value` to JSON and send it, enforcing the per-socket send-buffer
 * cap. Returns false (and sends nothing) if the socket is not OPEN. If the send
 * would push `bufferedAmount` past `maxBufferedAmountBytes`, the socket is closed
 * 1013 (slow consumer / try-again-later) and false is returned. Canonical safe
 * downlink-JSON write shared by every carrier adapter.
 */
export function sendJsonCapped(
  socket: WebSocket,
  value: unknown,
  maxBufferedAmountBytes: number,
): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  const data = JSON.stringify(value);
  if (socket.bufferedAmount + Buffer.byteLength(data, "utf8") > maxBufferedAmountBytes) {
    closeWebSocketWithFallback(socket, 1013, "websocket send buffer exceeded");
    return false;
  }
  socket.send(data);
  return true;
}
