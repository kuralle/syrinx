// SPDX-License-Identifier: MIT

import { WebSocket } from "ws";
import { closeWebSocketWithFallback } from "./websocket-close.js";

export class WebSocketStartupTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`websocket session startup exceeded ${String(timeoutMs)}ms`);
    this.name = "WebSocketStartupTimeoutError";
  }
}

export async function withWebSocketStartupTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return await promise;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new WebSocketStartupTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

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

/** Minimal closable shape: a voice websocket server (or any server) that drains on graceful close. */
export interface GracefulClosable {
  close(opts?: { graceful?: boolean; drainDeadlineMs?: number }): Promise<void>;
}

/**
 * Wire process termination signals to the server's graceful drain so a deploy/scale-down
 * drains active calls instead of killing them (Hard Rule: "drain, don't kill"). Idempotent
 * (a second signal during shutdown is ignored). Returns a disposer that removes the handlers.
 *
 * Production hosts call this once after creating the server:
 *   installGracefulShutdown(server, { drainDeadlineMs: 10_000, onClosed: () => process.exit(0) });
 */
export function installGracefulShutdown(
  server: GracefulClosable,
  opts?: {
    readonly drainDeadlineMs?: number;
    readonly signals?: readonly NodeJS.Signals[];
    readonly onClosed?: () => void;
    readonly onError?: (err: unknown) => void;
  },
): () => void {
  const drainDeadlineMs = opts?.drainDeadlineMs ?? 10_000;
  const signals = opts?.signals ?? (["SIGTERM", "SIGINT"] as const);
  let shuttingDown = false;
  const handler = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    server
      .close({ graceful: true, drainDeadlineMs })
      .then(() => opts?.onClosed?.())
      .catch((err: unknown) => (opts?.onError ? opts.onError(err) : opts?.onClosed?.()));
  };
  for (const signal of signals) process.once(signal, handler);
  return () => {
    for (const signal of signals) process.removeListener(signal, handler);
  };
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
