// SPDX-License-Identifier: MIT
//
// Regression: disposing a Node `ws` socket that is still CONNECTING must not crash
// the process. `ws.close()` on a connecting socket emits an asynchronous 'error'
// event ("WebSocket was closed before the connection was established"); dispose()
// removeAllListeners()'d the error sink, so without re-attaching one the event
// becomes an uncaught exception. This happens whenever a caller hangs up during a
// slow provider connect (surfaced live via the Cartesia TTS plugin teardown).

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { createNodeWsSocket } from "./node.js";

describe("createNodeWsSocket dispose while connecting", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not raise an unhandled 'error' when disposed mid-handshake", async () => {
    // A socket to a non-routable address stays in CONNECTING. If dispose() leaked an
    // unhandled 'error', the vitest process would record an uncaughtException and fail
    // this file — reaching the assertion is the proof.
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown): void => {
      uncaught.push(err);
    };
    process.on("uncaughtException", onUncaught);
    try {
      // createNodeWsSocket is synchronous; await narrows the SocketFactory union.
      const socket = await createNodeWsSocket("ws://10.255.255.1:9999", {});
      socket.dispose(); // synchronous, while readyState === CONNECTING
      await new Promise((resolve) => setTimeout(resolve, 150));
    } finally {
      process.off("uncaughtException", onUncaught);
    }
    expect(uncaught).toEqual([]);
  });

  it("clears the verify timeout when disposed during verify", async () => {
    vi.useFakeTimers();
    const server = await new Promise<WebSocketServer>((resolve) => {
      let next: WebSocketServer;
      next = new WebSocketServer({ port: 0 }, () => resolve(next));
    });
    server.on("connection", (ws) => {
      ws.on("ping", () => undefined);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server address");

    const socket = await createNodeWsSocket(`ws://127.0.0.1:${String(address.port)}/`, {});
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for websocket open")), 2000);
      socket.onOpen(() => {
        clearTimeout(timer);
        resolve();
      });
    });

    const verifyPromise = socket.verify(5000);
    socket.dispose();
    await vi.advanceTimersByTimeAsync(6000);
    await expect(verifyPromise).resolves.toBe(false);

    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.useRealTimers();
  });
});
