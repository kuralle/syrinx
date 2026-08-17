// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";
import { WebSocket } from "ws";
import { VoiceAgentSession } from "@kuralle-syrinx/core";
import { InMemorySessionStore } from "./session-store.js";
import { runVoiceEdgeWebSocketConnection } from "./edge.js";
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

function openSocket(): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    on: () => undefined,
    close: () => undefined,
  } as unknown as WebSocket;
}

class FakeEdgeSocket {
  isOpen = true;
  disposed = false;
  readonly sent: Array<string | Uint8Array> = [];
  #onMessage?: (data: string | Uint8Array, isBinary: boolean) => void;
  #onClose?: (code: number, reason: string) => void;

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }
  keepAlivePing(): void {}
  async verify(): Promise<boolean> {
    return this.isOpen;
  }
  dispose(): void {
    this.disposed = true;
    this.isOpen = false;
    this.#onClose?.(1000, "disposed");
  }
  onOpen(): void {}
  onMessage(handler: (data: string | Uint8Array, isBinary: boolean) => void): void {
    this.#onMessage = handler;
  }
  onClose(handler: (code: number, reason: string) => void): void {
    this.#onClose = handler;
  }
  onError(): void {}
  emitClose(): void {
    this.#onClose?.(1000, "closed");
  }
}

function minimalTransportAdapter(
  session: VoiceAgentSession,
  overrides: Partial<TransportAdapter<null>> = {},
): TransportAdapter<null> {
  return {
    createState: () => null,
    acquireSession: async () => ({ session, resumed: false }),
    wireSession: () => () => undefined,
    processMessage: () => undefined,
    onDisconnect: () => undefined,
    onStartupTimeout: () => undefined,
    sendError: () => undefined,
    sendStartupError: () => undefined,
    ...overrides,
  };
}

describe("session_start on transport-host", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits session_start exactly once when startup succeeds", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const events: Array<Record<string, unknown>> = [];
    session.on("session_start", (event) => {
      events.push(event as Record<string, unknown>);
    });

    await runWebSocketConnection(
      openSocket(),
      { url: "/ws" } as IncomingMessage,
      hostConfig,
      minimalTransportAdapter(session),
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.totalMs).toEqual(expect.any(Number));
    expect(events[0]?.unattributedMs).toEqual(expect.any(Number));
    expect(events[0]).toHaveProperty("transportMs");
    expect(events[0]).toHaveProperty("admissionMs");
    expect(events[0]).toHaveProperty("pluginInitMs");
    const attributed =
      Number(events[0]?.transportMs ?? 0) +
      Number(events[0]?.admissionMs ?? 0) +
      Number(events[0]?.pluginInitMs ?? 0);
    expect(events[0]?.unattributedMs).toBe(Number(events[0]?.totalMs) - attributed);
  });

  it("does not emit session_start when acquireSession throws", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const events: unknown[] = [];
    session.on("session_start", (event) => {
      events.push(event);
    });
    const close = vi.fn();
    const socket = {
      readyState: WebSocket.OPEN,
      on: () => undefined,
      close,
    } as unknown as WebSocket;

    await runWebSocketConnection(
      socket,
      { url: "/ws" } as IncomingMessage,
      hostConfig,
      minimalTransportAdapter(session, {
        acquireSession: async () => {
          throw new Error("admission failed");
        },
      }),
    );

    expect(events).toHaveLength(0);
    expect(close).toHaveBeenCalled();
  });

  it("does not emit session_start on startup timeout", async () => {
    vi.useFakeTimers();
    const session = new VoiceAgentSession({ plugins: {} });
    const events: unknown[] = [];
    session.on("session_start", (event) => {
      events.push(event);
    });
    const close = vi.fn();
    const socket = {
      readyState: WebSocket.OPEN,
      on: () => undefined,
      close,
    } as unknown as WebSocket;

    const runPromise = runWebSocketConnection(
      socket,
      { url: "/ws" } as IncomingMessage,
      { ...hostConfig, startupTimeoutMs: 50 },
      minimalTransportAdapter(session, {
        acquireSession: () => new Promise(() => undefined),
      }),
    );
    await vi.advanceTimersByTimeAsync(60);
    await runPromise;

    expect(events).toHaveLength(0);
    expect(close).toHaveBeenCalled();
  });

  it("does not emit session_start when the socket closes mid-acquire", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const events: unknown[] = [];
    session.on("session_start", (event) => {
      events.push(event);
    });
    const closeHandlers: Array<() => void> = [];
    const socket = {
      readyState: WebSocket.OPEN,
      on: (event: string, handler: () => void) => {
        if (event === "close") closeHandlers.push(handler);
      },
      close: () => {
        for (const handler of closeHandlers) handler();
      },
    } as unknown as WebSocket;

    await runWebSocketConnection(
      socket,
      { url: "/ws" } as IncomingMessage,
      hostConfig,
      minimalTransportAdapter(session, {
        acquireSession: async ({ shouldAbort }) => {
          socket.close();
          while (!shouldAbort()) {
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
          return { session, resumed: false };
        },
      }),
    );

    expect(events).toHaveLength(0);
  });

  it("does not acquire a session when the socket is already closed before startup", async () => {
    const acquireSession = vi.fn(async () => ({
      session: new VoiceAgentSession({ plugins: {} }),
      resumed: false,
    }));

    await runWebSocketConnection(
      closedSocket(),
      { url: "/ws" } as IncomingMessage,
      hostConfig,
      minimalTransportAdapter(new VoiceAgentSession({ plugins: {} }), { acquireSession }),
    );

    expect(acquireSession).not.toHaveBeenCalled();
  });
});

describe("session_start on edge", () => {
  it("emits session_start exactly once when startup succeeds", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const events: Array<Record<string, unknown>> = [];
    session.on("session_start", (event) => {
      events.push(event as Record<string, unknown>);
    });
    const socket = new FakeEdgeSocket();

    await runVoiceEdgeWebSocketConnection(socket, new Request("https://edge.test/ws?sessionId=s1"), {
      sessionStore: new InMemorySessionStore(),
      createSession: async () => session,
    });

    expect(socket.sent.some((m) => typeof m === "string" && JSON.parse(m).type === "ready")).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]?.totalMs).toEqual(expect.any(Number));
    expect(events[0]).toHaveProperty("admissionMs");
    const attributed = Number(events[0]?.admissionMs ?? 0);
    expect(events[0]?.unattributedMs).toBe(Number(events[0]?.totalMs) - attributed);
  });

  // STRUCTURAL, deliberately not clock-based. Under vitest (and under workerd) Date.now()
  // advances normally, so a test that merely reads non-zero values proves nothing — workerd
  // is precisely where the production bug does not reproduce. This asserts the CHOICE
  // instead: the edge must not hand `noteSessionStart` a boundary it cannot honestly
  // observe on Cloudflare, where Date.now() returns the time of the last I/O.
  //
  // Measured on a deployed Worker, 2026-08-17, 10 sessions: transportMs 0/10 and
  // pluginInitMs 0/10, while admissionMs ran 48-1943ms. The Node host is the control —
  // there pluginInitMs is non-zero on 3 of 5 runs, so the zeros above are the frozen clock
  // rather than a fast path. Re-adding either boundary here reintroduces a wrong zero.
  it("omits the stages this host cannot honestly observe — no wrong zeros on the edge", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const events: Array<Record<string, unknown>> = [];
    session.on("session_start", (event) => {
      events.push(event as Record<string, unknown>);
    });
    const socket = new FakeEdgeSocket();

    await runVoiceEdgeWebSocketConnection(socket, new Request("https://edge.test/ws?sessionId=s-omit"), {
      sessionStore: new InMemorySessionStore(),
      createSession: async () => session,
    });

    expect(events).toHaveLength(1);
    // The two stages whose boundaries are not separated by real I/O on this host.
    expect(events[0]).not.toHaveProperty("transportMs");
    expect(events[0]).not.toHaveProperty("pluginInitMs");
    // What remains must still be a real, attributable measurement.
    expect(events[0]).toHaveProperty("admissionMs");
    expect(events[0]?.totalMs).toEqual(expect.any(Number));
    expect(events[0]?.unattributedMs).toBe(
      Number(events[0]?.totalMs) - Number(events[0]?.admissionMs ?? 0),
    );
  });

  it("does not emit session_start when createSession throws", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const events: unknown[] = [];
    session.on("session_start", (event) => {
      events.push(event);
    });
    const socket = new FakeEdgeSocket();

    await runVoiceEdgeWebSocketConnection(socket, new Request("https://edge.test/ws?sessionId=s2"), {
      sessionStore: new InMemorySessionStore(),
      createSession: async () => {
        throw new Error("create failed");
      },
    });

    expect(events).toHaveLength(0);
    expect(socket.disposed).toBe(true);
  });

  it("does not emit session_start when the socket closes during admission", async () => {
    const session = new VoiceAgentSession({ plugins: {} });
    const events: unknown[] = [];
    session.on("session_start", (event) => {
      events.push(event);
    });
    const socket = new FakeEdgeSocket();

    await runVoiceEdgeWebSocketConnection(socket, new Request("https://edge.test/ws?sessionId=s3"), {
      sessionStore: new InMemorySessionStore(),
      createSession: async () => {
        socket.emitClose();
        return session;
      },
    });

    expect(events).toHaveLength(0);
  });
});
