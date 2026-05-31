// SPDX-License-Identifier: MIT

import type { Server as HttpServer } from "node:http";
import { afterEach, beforeEach } from "vitest";
import WebSocket from "ws";

export const DEFAULT_CONDITION_TIMEOUT_MS = 5000;

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
    await Promise.allSettled(
      activeHttpServers.map((httpServer) => new Promise<void>((resolve) => httpServer.close(() => resolve()))),
    );
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
