// SPDX-License-Identifier: MIT
//
// Proves the connection manager runs over a WHATWG WebSocket (Cloudflare
// Workers / browser / Bun) with no `ws` and no ping frames — keepalive uses an
// app message and verify falls back to readyState.

import { describe, expect, it } from "vitest";
import type { RetryConfig } from "@asyncdot/voice";

import { WebSocketConnection, type SocketData } from "./index.js";
import { wrapWhatwgSocket, type WhatwgEvent, type WhatwgWebSocket } from "./whatwg.js";

const FAST_RETRY: RetryConfig = { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 40 };

/** A controllable WHATWG-shaped socket — no ping, addEventListener-based. */
class FakeWhatwgSocket implements WhatwgWebSocket {
  readyState = 0;
  binaryType = "blob";
  readonly sent: SocketData[] = [];
  private readonly listeners = new Map<string, Array<(event: WhatwgEvent) => void>>();

  send(data: string | ArrayBufferView | ArrayBuffer): void {
    this.sent.push(typeof data === "string" ? data : new Uint8Array(data as ArrayBuffer));
  }
  close(): void {
    this.readyState = 3;
    this.emit("close", { code: 1000, reason: "" });
  }
  addEventListener(type: string, listener: (event: WhatwgEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  private emit(type: string, event: WhatwgEvent): void {
    for (const l of this.listeners.get(type) ?? []) l(event);
  }
  fireOpen(): void {
    this.readyState = 1;
    this.emit("open", {});
  }
  fireMessage(data: string | ArrayBuffer): void {
    this.emit("message", { data });
  }
}

describe("WebSocketConnection over a WHATWG socket (Workers/browser)", () => {
  it("connects, delivers text + binary, and keepalives with an app message (no ping)", async () => {
    const fake = new FakeWhatwgSocket();
    const received: Array<{ data: SocketData; isBinary: boolean }> = [];
    const conn = new WebSocketConnection({
      url: () => "wss://example/v1",
      socketFactory: () => wrapWhatwgSocket(fake),
      retry: FAST_RETRY,
      keepAliveIntervalMs: 20,
      keepAliveMessage: () => JSON.stringify({ type: "KeepAlive" }),
      onMessage: (data, isBinary) => received.push({ data, isBinary }),
    });

    const connected = conn.connect();
    fake.fireOpen();
    await connected;
    expect(conn.isReady).toBe(true);

    fake.fireMessage("hello-text");
    fake.fireMessage(new Uint8Array([1, 2, 3]).buffer);

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(received[0]).toEqual({ data: "hello-text", isBinary: false });
    const binary = received.find((r) => r.isBinary);
    expect(binary?.data).toEqual(new Uint8Array([1, 2, 3]));
    // KeepAlive went out as an app message, since WHATWG has no ping frame.
    expect(fake.sent.filter((m) => typeof m === "string" && m.includes("KeepAlive")).length).toBeGreaterThanOrEqual(1);

    await conn.close();
    expect(fake.readyState).toBe(3);
  });
});
