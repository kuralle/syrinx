// SPDX-License-Identifier: MIT
//
// Proves the Workers fetch-upgrade adapter drives the full manager: the async
// socket factory is awaited, the auth headers + Upgrade go out on the fetch, and
// the accepted (already-open) socket connects without an "open" event.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { RetryConfig } from "@kuralle-syrinx/core";

import { WebSocketConnection } from "./index.js";
import { createWorkersSocket } from "./workers.js";
import type { WebSocketEventLike } from "./web-socket.js";

const FAST_RETRY: RetryConfig = { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 40 };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A Workers-style already-open socket returned by a fetch upgrade. */
class FakeWorkersSocket {
  readyState = 1; // already OPEN, as after a fetch upgrade
  binaryType = "blob";
  accepted = false;
  readonly sent: Array<string | ArrayBufferView | ArrayBuffer> = [];
  private readonly listeners = new Map<string, Array<(event: WebSocketEventLike) => void>>();
  accept(): void {
    this.accepted = true;
  }
  send(data: string | ArrayBufferView | ArrayBuffer): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  addEventListener(type: string, listener: (event: WebSocketEventLike) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  fire(type: string, event: WebSocketEventLike): void {
    for (const l of this.listeners.get(type) ?? []) l(event);
  }
}

describe("createWorkersSocket (Cloudflare fetch-upgrade)", () => {
  it("upgrades with auth headers and connects an already-open socket", async () => {
    const fake = new FakeWorkersSocket();
    const fetchMock = vi.fn(async (_url: string, _init: { headers: Record<string, string> }) => ({
      status: 101,
      webSocket: fake,
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const received: string[] = [];
    const conn = new WebSocketConnection({
      url: () => "wss://api.deepgram.com/v1/listen",
      headers: { Authorization: "Token secret-key" },
      socketFactory: createWorkersSocket,
      retry: FAST_RETRY,
      onMessage: (data) => {
        if (typeof data === "string") received.push(data);
      },
    });

    await conn.connect();
    expect(conn.isReady).toBe(true);
    expect(fake.accepted).toBe(true);

    // The fetch carried the Upgrade + the provider auth header.
    const init = fetchMock.mock.calls[0]![1];
    expect(init.headers.Upgrade).toBe("websocket");
    expect(init.headers.Authorization).toBe("Token secret-key");

    fake.fire("message", { data: "{\"type\":\"Results\"}" });
    expect(received).toEqual(["{\"type\":\"Results\"}"]);

    conn.send("audio-frame");
    expect(fake.sent).toContain("audio-frame");

    await conn.close();
  });
});
