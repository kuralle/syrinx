// SPDX-License-Identifier: MIT

import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { VoiceAgentSession } from "@asyncdot/voice";
import {
  createSmartPbxMediaStreamServer,
  createTelnyxMediaStreamServer,
  createTwilioMediaStreamServer,
  createVoiceWebSocketServer,
} from "./index.js";
import { TRANSPORT_ADMISSION_REJECTED_METRIC } from "./transport-host.js";
import {
  openBrowserSocketReady,
  openSocket,
  registerHttpServer,
  registerServer,
  registerSocket,
  setupTransportTestCleanup,
  waitForClose,
  waitForCondition,
} from "./test-helpers.js";

setupTransportTestCleanup();

function websocketUrl(port: number): string {
  return `ws://127.0.0.1:${port}/ws`;
}

describe("WT-08 admission control and upgrade routing", () => {
  it("rejects connections beyond maxConcurrentSessions with 1013 and transport.admission_rejected", async () => {
    const metrics: string[] = [];
    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      maxConcurrentSessions: 2,
      onTransportMetric: (name) => metrics.push(name),
      createSession: () => new VoiceAgentSession({ plugins: {} }),
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const first = await openBrowserSocketReady(websocketUrl(address.port));
    const second = await openBrowserSocketReady(websocketUrl(address.port));
    expect(server.wsServer.clients.size).toBe(2);

    const rejected = registerSocket(new WebSocket(websocketUrl(address.port)));
    await new Promise<void>((resolveOpen, reject) => {
      rejected.once("open", resolveOpen);
      rejected.once("error", reject);
    });
    const closeCode = await waitForClose(rejected);

    expect(closeCode).toBe(1013);
    expect(metrics).toContain(TRANSPORT_ADMISSION_REJECTED_METRIC);

    first.close();
    second.close();
    await server.close();
  });

  it("allows a new connection after an admitted session disconnects", async () => {
    const server = registerServer(await createVoiceWebSocketServer({
      port: 0,
      maxConcurrentSessions: 1,
      createSession: () => new VoiceAgentSession({ plugins: {} }),
    }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const first = await openBrowserSocketReady(websocketUrl(address.port));
    first.close();
    await waitForCondition(() => server.wsServer.clients.size === 0);

    const second = await openBrowserSocketReady(websocketUrl(address.port));
    expect(second.readyState).toBe(WebSocket.OPEN);

    second.close();
    await server.close();
  });

  it("destroys sockets on unmatched upgrade paths instead of leaking them", async () => {
    const httpServer = registerHttpServer(createServer());
    const server = registerServer(await createVoiceWebSocketServer({
      server: httpServer,
      createSession: () => new VoiceAgentSession({ plugins: {} }),
    }));
    await new Promise<void>((resolveListen, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", () => {
        httpServer.off("error", reject);
        resolveListen();
      });
    });
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const unknownPathClient = registerSocket(
      new WebSocket(`ws://127.0.0.1:${String(address.port)}/unknown-path`),
    );
    const closeCode = await waitForClose(unknownPathClient);
    expect(closeCode).toBe(1006);

    const registered = await openBrowserSocketReady(websocketUrl(address.port));
    expect(registered.readyState).toBe(WebSocket.OPEN);

    registered.close();
    await server.close();
    await new Promise<void>((resolveClose) => httpServer.close(() => resolveClose()));
  });

  it("routes multiple provider websocket paths on a shared HTTP server without handshake cross-talk", async () => {
    const httpServer = registerHttpServer(createServer());
    const [twilio, telnyx, smartpbx] = await Promise.all([
      registerServer(await createTwilioMediaStreamServer({
        server: httpServer,
        createSession: () => new VoiceAgentSession({ plugins: {} }),
      })),
      registerServer(await createTelnyxMediaStreamServer({
        server: httpServer,
        createSession: () => new VoiceAgentSession({ plugins: {} }),
      })),
      registerServer(await createSmartPbxMediaStreamServer({
        server: httpServer,
        createSession: () => new VoiceAgentSession({ plugins: {} }),
      })),
    ]);
    await new Promise<void>((resolveListen, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", () => {
        httpServer.off("error", reject);
        resolveListen();
      });
    });
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const clients = await Promise.all([
      openSocket(`ws://127.0.0.1:${String(address.port)}/twilio`, { perMessageDeflate: false }),
      openSocket(`ws://127.0.0.1:${String(address.port)}/telnyx`, { perMessageDeflate: false }),
      openSocket(`ws://127.0.0.1:${String(address.port)}/media-stream`, { perMessageDeflate: false }),
    ]);
    expect(clients.map((client) => client.readyState)).toEqual([
      WebSocket.OPEN,
      WebSocket.OPEN,
      WebSocket.OPEN,
    ]);

    const scanner = registerSocket(
      new WebSocket(`ws://127.0.0.1:${String(address.port)}/random-scanner-path`),
    );
    expect(await waitForClose(scanner)).toBe(1006);

    for (const client of clients) client.close();
    await Promise.all([twilio.close(), telnyx.close(), smartpbx.close()]);
    await new Promise<void>((resolveClose) => httpServer.close(() => resolveClose()));
  });
});
