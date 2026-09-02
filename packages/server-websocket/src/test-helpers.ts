// SPDX-License-Identifier: MIT

import type { Server as HttpServer } from "node:http";
import { afterEach, beforeEach } from "vitest";
import WebSocket from "ws";

export const DEFAULT_CONDITION_TIMEOUT_MS = 5000;

const HTTP_SERVER_CLOSE_FALLBACK_MS = 500;

function closeHttpServerBounded(httpServer: HttpServer): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(fallbackTimer);
      resolve();
    };

    const fallbackTimer = setTimeout(finish, HTTP_SERVER_CLOSE_FALLBACK_MS);

    if (typeof httpServer.closeAllConnections === "function") {
      httpServer.closeAllConnections();
    } else if (typeof httpServer.closeIdleConnections === "function") {
      httpServer.closeIdleConnections();
    }

    httpServer.close(() => finish());
  });
}

interface ClosableServer {
  close(): Promise<void>;
}

let activeServers: ClosableServer[] = [];
let activeHttpServers: HttpServer[] = [];
let activeSockets: WebSocket[] = [];

export function registerServer<T extends ClosableServer>(server: T): T {
  activeServers.push(server);
  return server;
}

export interface LoopbackTransportHandle extends ClosableServer {
  address(): ReturnType<HttpServer["address"]>;
}

export interface StartedLoopbackTransport<T extends LoopbackTransportHandle> {
  readonly server: T;
  readonly port: number;
}

/**
 * Start a transport server on an ephemeral port bound to 127.0.0.1 explicitly —
 * never the dual-stack wildcard that `listen(0)` without a host produces. A
 * wildcard listener can be shadowed for 127.0.0.1 traffic by any other process
 * that binds the same port number on 127.0.0.1 specifically: the kernel allows
 * both to listen ([::]:P and 127.0.0.1:P) and routes loopback traffic to the more
 * specific address, so the client reaches the wrong server and the test sees
 * `Unexpected server response: 404` or `Socket closed before matching JSON
 * message` — flaky only under `pnpm -r test`, where sibling suites bind their own
 * loopback servers concurrently. A specific-address bind cannot be shadowed: a
 * second bind of 127.0.0.1:P fails with EADDRINUSE, so the client always reaches
 * the server it asked for. Production code must keep the wildcard default; only
 * tests, which dial 127.0.0.1, take the specific bind.
 */
export async function startLoopbackTransportServer<
  Options extends { port?: number; host?: string },
  T extends LoopbackTransportHandle,
>(create: (options: Options) => Promise<T>, options: Options): Promise<StartedLoopbackTransport<T>> {
  const server = registerServer(await create({ ...options, port: 0, host: "127.0.0.1" }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  if (address.address !== "127.0.0.1") {
    throw new Error(`Expected transport server bound to 127.0.0.1, got ${address.address}`);
  }
  return { server, port: address.port };
}

export function registerHttpServer(server: HttpServer): HttpServer {
  activeHttpServers.push(server);
  return server;
}

export function registerSocket(socket: WebSocket): WebSocket {
  activeSockets.push(socket);
  return socket;
}

export function setupTransportTestCleanup(): void {
  beforeEach(() => {
    activeServers = [];
    activeHttpServers = [];
    activeSockets = [];
  });

  afterEach(async () => {
    await Promise.allSettled(activeSockets.map((socket) => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }
      return new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        socket.once("close", () => resolve());
      });
    }));
    await Promise.allSettled(activeServers.map((server) => server.close()));
    await Promise.allSettled(activeHttpServers.map((httpServer) => closeHttpServerBounded(httpServer)));
    activeServers = [];
    activeHttpServers = [];
    activeSockets = [];
  });
}

export async function openSocket(url: string, options?: WebSocket.ClientOptions): Promise<WebSocket> {
  const socket = registerSocket(new WebSocket(url, options));
  await new Promise<void>((resolveOpen, reject) => {
    socket.once("open", resolveOpen);
    socket.once("error", reject);
  });
  return socket;
}

/**
 * Open a client socket with room to attach message/close listeners BEFORE the
 * connection opens. ws delivers every frame in a received chunk synchronously —
 * open, message, close — before any promise continuation runs, so a listener
 * attached after `await openSocket(...)` misses server-unsolicited frames that
 * coalesce with the handshake when the event loop stalls under `pnpm -r test`
 * load (observed: startup-timeout tests reading `Socket closed before matching
 * JSON message`). Tests that expect a message the server sends unprompted right
 * after accept must attach via this helper, then await `opened`.
 */
export function connectSocket(url: string, options?: WebSocket.ClientOptions): { readonly socket: WebSocket; readonly opened: Promise<void> } {
  const socket = registerSocket(new WebSocket(url, options));
  const opened = new Promise<void>((resolveOpen, reject) => {
    socket.once("open", resolveOpen);
    socket.once("error", reject);
  });
  return { socket, opened };
}

export async function openSmartPbxSocket(url: string): Promise<WebSocket> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < DEFAULT_CONDITION_TIMEOUT_MS) {
    const socket = registerSocket(new WebSocket(url));
    try {
      await new Promise<void>((resolveOpen, reject) => {
        const cleanup = (): void => {
          socket.off("open", onOpen);
          socket.off("error", onError);
          socket.off("unexpected-response", onUnexpectedResponse);
        };
        const onOpen = (): void => {
          cleanup();
          resolveOpen();
        };
        const onError = (err: Error): void => {
          cleanup();
          reject(err);
        };
        const onUnexpectedResponse = (_request: unknown, response: { statusCode?: number; resume: () => void }): void => {
          cleanup();
          response.resume();
          reject(new Error(`Unexpected server response: ${String(response.statusCode)}`));
        };
        socket.once("open", onOpen);
        socket.once("error", onError);
        socket.once("unexpected-response", onUnexpectedResponse);
      });
      return socket;
    } catch (err) {
      socket.terminate();
      lastError = err;
      if (!(err instanceof Error) || !err.message.includes("Unexpected server response: 404")) throw err;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function openBrowserSocketReady(url: string, options?: WebSocket.ClientOptions): Promise<WebSocket> {
  const socket = registerSocket(new WebSocket(url, options));
  await new Promise<void>((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
      if (isBinary) return;
      try {
        const parsed = JSON.parse(data.toString()) as { type?: string };
        if (parsed.type === "ready") {
          socket.off("message", onMessage);
          resolve();
        }
      } catch {
        // Ignore non-JSON frames while waiting for ready.
      }
    };
    socket.on("message", onMessage);
    socket.once("error", reject);
  });
  return socket;
}

export async function openBrowserClientAndReadReady(
  url: string,
  options?: WebSocket.ClientOptions,
): Promise<[WebSocket, any]> {
  const socket = registerSocket(new WebSocket(url, options));
  let readyMessage: any;
  await new Promise<void>((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
      if (isBinary) return;
      try {
        const parsed = JSON.parse(data.toString()) as { type?: string };
        if (parsed.type === "ready") {
          readyMessage = parsed;
          socket.off("message", onMessage);
          resolve();
        }
      } catch {
        // Ignore non-JSON frames while waiting for ready.
      }
    };
    socket.on("message", onMessage);
    socket.once("error", reject);
  });
  return [socket, readyMessage];
}

export async function readJson(socket: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      socket.off("message", onMessage);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    const onMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
      if (isBinary) return;
      cleanup();
      resolve(JSON.parse(data.toString()));
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("Socket closed before JSON message"));
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    socket.on("message", onMessage);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

export async function readJsonMatching(
  socket: WebSocket,
  predicate: (message: any) => boolean,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      socket.off("message", onMessage);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    const onMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
      if (isBinary) return;
      const message = JSON.parse(data.toString()) as unknown;
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("Socket closed before matching JSON message"));
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    socket.on("message", onMessage);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

export async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = DEFAULT_CONDITION_TIMEOUT_MS,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

export function waitForClose(socket: WebSocket): Promise<number> {
  if (socket.readyState === WebSocket.CLOSED) {
    return Promise.resolve(1006);
  }
  return new Promise<number>((resolve) => {
    let done = false;
    const finish = (code: number): void => {
      if (!done) {
        done = true;
        resolve(code);
      }
    };
    socket.on("close", (code) => finish(code));
    socket.on("error", () => finish(1006));
  });
}
