// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";
import { WebSocket } from "ws";
import { VoiceAgentSession } from "@asyncdot/voice";
import { runWebSocketConnection, type TransportAdapter } from "./transport-host.js";

const hostConfig = {
  heartbeatIntervalMs: 30_000,
  startupTimeoutMs: 500,
  maxSessionDurationMs: 60_000,
  maxBufferedAmountBytes: 1_000_000,
  maxInboundMessageBytes: 1_000_000,
};

function closedSocket(): WebSocket {
  return {
    readyState: WebSocket.CLOSED,
    on: () => undefined,
    close: () => undefined,
  } as unknown as WebSocket;
}

describe("runWebSocketConnection startup", () => {
  it("does not acquire a session when the socket is already closed before startup", async () => {
    const acquireSession = vi.fn(async () => ({
      session: new VoiceAgentSession({ plugins: {} }),
      resumed: false,
    }));
    const adapter: TransportAdapter<null> = {
      createState: () => null,
      acquireSession,
      wireSession: () => () => undefined,
      processMessage: () => undefined,
      onDisconnect: () => undefined,
      onStartupTimeout: () => undefined,
      sendError: () => undefined,
      sendStartupError: () => undefined,
    };

    await runWebSocketConnection(
      closedSocket(),
      { url: "/ws" } as IncomingMessage,
      hostConfig,
      adapter,
    );

    expect(acquireSession).not.toHaveBeenCalled();
  });
});
