// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import type { RetryConfig } from "@asyncdot/voice";

import { WebSocketConnection, type ManagedSocket, type SocketFactory } from "./index.js";
import { createNodeWsSocket } from "./node.js";

let servers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) client.terminate();
          server.close(() => resolve());
        }),
    ),
  );
});

async function createServer(onConnection: (socket: WebSocket) => void): Promise<{ url: string; port: number; server: WebSocketServer }> {
  const server = await new Promise<WebSocketServer>((resolve) => {
    let next: WebSocketServer;
    next = new WebSocketServer({ port: 0 }, () => resolve(next));
  });
  servers.push(server);
  server.on("connection", onConnection);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address");
  return { url: `ws://127.0.0.1:${address.port}/`, port: address.port, server };
}

const FAST_RETRY: RetryConfig = { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 40 };

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

describe("WebSocketConnection", () => {
  it("delivers messages and holds the socket open with a KeepAlive", async () => {
    const serverReceived: string[] = [];
    const { url } = await createServer((socket) => {
      socket.on("message", (data, isBinary) => {
        if (!isBinary) serverReceived.push(data.toString());
      });
      socket.send("hello-from-server");
    });

    const messages: string[] = [];
    const conn = new WebSocketConnection({
      url: () => url,
      socketFactory: createNodeWsSocket,
      retry: FAST_RETRY,
      keepAliveIntervalMs: 30,
      keepAliveMessage: () => JSON.stringify({ type: "KeepAlive" }),
      onMessage: (data, isBinary) => {
        if (!isBinary) messages.push(data.toString());
      },
    });
    await conn.connect();
    await waitFor(() => messages.includes("hello-from-server"));
    // Several keepalive intervals should have elapsed.
    await waitFor(() => serverReceived.filter((m) => m.includes("KeepAlive")).length >= 2);

    expect(messages).toContain("hello-from-server");
    expect(serverReceived.filter((m) => m.includes("KeepAlive")).length).toBeGreaterThanOrEqual(2);

    await conn.close();
  });

  it("reconnects with verification after the server drops the socket", async () => {
    let connections = 0;
    const { url } = await createServer((socket) => {
      connections += 1;
      // ws auto-replies to ping with pong, so verify() passes.
      if (connections === 1) {
        // Drop the first connection shortly after it opens.
        setTimeout(() => socket.close(1011, "transient"), 20);
      }
    });

    let reconnecting = 0;
    let reconnected = 0;
    const conn = new WebSocketConnection({
      url: () => url,
      socketFactory: createNodeWsSocket,
      retry: FAST_RETRY,
      minStableMs: 0, // don't treat the deliberate drop as a quick failure
      onMessage: () => undefined,
      onReconnecting: () => {
        reconnecting += 1;
      },
      onReconnected: () => {
        reconnected += 1;
      },
    });
    await conn.connect();
    await waitFor(() => reconnected >= 1);

    expect(reconnecting).toBeGreaterThanOrEqual(1);
    expect(reconnected).toBe(1);
    expect(connections).toBeGreaterThanOrEqual(2);
    // The reconnected socket is usable.
    expect(conn.isReady).toBe(true);
    conn.send("after-reconnect");

    await conn.close();
  });

  it("gives up and reports unrecoverable when the server stays down", async () => {
    const { url, server } = await createServer(() => undefined);
    let unrecoverable: Error | null = null;
    const conn = new WebSocketConnection({
      url: () => url,
      socketFactory: createNodeWsSocket,
      retry: FAST_RETRY,
      maxReconnectAttempts: 2,
      minStableMs: 0,
      onMessage: () => undefined,
      onUnrecoverable: (err) => {
        unrecoverable = err;
      },
    });
    await conn.connect();
    expect(conn.isReady).toBe(true);

    // Kill the server: the live socket drops and every reconnect attempt fails.
    await new Promise<void>((resolve) => {
      for (const client of server.clients) client.terminate();
      server.close(() => resolve());
    });

    await waitFor(() => unrecoverable !== null, 3000);
    expect(unrecoverable).toBeInstanceOf(Error);
    expect((unrecoverable! as Error).message).toContain("failed to reconnect");

    await conn.close();
  });

  it("rejects connect when disposed before the socket opens", async () => {
    const hangingSocket: ManagedSocket = {
      get isOpen() {
        return false;
      },
      send: () => undefined,
      keepAlivePing: () => undefined,
      verify: async () => false,
      dispose: () => undefined,
      onOpen: () => undefined,
      onMessage: () => undefined,
      onClose: () => undefined,
      onError: () => undefined,
    };
    const socketFactory: SocketFactory = () => hangingSocket;
    const conn = new WebSocketConnection({
      url: () => "ws://127.0.0.1:1/",
      socketFactory,
      retry: FAST_RETRY,
      onMessage: () => undefined,
    });

    const connectPromise = conn.connect();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await conn.close();

    await expect(connectPromise).rejects.toThrow(/disposed/i);
  });

  it("stops reconnecting when the socket keeps dying right after connecting", async () => {
    // Server accepts + answers ping (verify passes) but closes ~15ms after open,
    // every time — backoff can't fix this, so the quick-failure guard must give up.
    const { url } = await createServer((socket) => {
      setTimeout(() => socket.close(1011, "flap"), 15);
    });

    let unrecoverable: Error | null = null;
    let reconnects = 0;
    const conn = new WebSocketConnection({
      url: () => url,
      socketFactory: createNodeWsSocket,
      retry: FAST_RETRY,
      minStableMs: 200,
      maxQuickFailures: 2,
      onMessage: () => undefined,
      onReconnected: () => {
        reconnects += 1;
      },
      onUnrecoverable: (err) => {
        unrecoverable = err;
      },
    });
    await conn.connect();
    await waitFor(() => unrecoverable !== null, 3000);

    expect((unrecoverable! as Error).message).toContain("check credentials or provider policy");
    // It should bail out quickly, not loop forever.
    expect(reconnects).toBeLessThanOrEqual(3);

    await conn.close();
  });
});
