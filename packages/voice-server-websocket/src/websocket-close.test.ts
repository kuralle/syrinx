// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { sendJsonCapped } from "./websocket-close.js";

interface FakeSocket {
  readyState: number;
  bufferedAmount: number;
  sent: string[];
  closed: { code: number; reason: string } | null;
}

function makeSocket(overrides: Partial<FakeSocket> = {}): WebSocket {
  const socket: FakeSocket & { send(d: string): void; close(c: number, r: string): void; once(): void } = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    sent: [],
    closed: null,
    ...overrides,
    send(data: string) { this.sent.push(data); },
    close(code: number, reason: string) { this.closed = { code, reason }; this.readyState = WebSocket.CLOSING; },
    once() { /* close-cleanup listener — unused in these paths */ },
  };
  return socket as unknown as WebSocket;
}

describe("sendJsonCapped", () => {
  it("serializes and sends when OPEN and under the buffer cap", () => {
    const socket = makeSocket();
    const ok = sendJsonCapped(socket, { event: "media", n: 1 }, 1_000);
    expect(ok).toBe(true);
    expect((socket as unknown as FakeSocket).sent).toEqual([JSON.stringify({ event: "media", n: 1 })]);
  });

  it("sends nothing and returns false when the socket is not OPEN", () => {
    const socket = makeSocket({ readyState: WebSocket.CONNECTING });
    const ok = sendJsonCapped(socket, { event: "media" }, 1_000);
    expect(ok).toBe(false);
    expect((socket as unknown as FakeSocket).sent).toHaveLength(0);
  });

  it("closes 1013 and drops the message when the send would exceed the buffer cap", () => {
    const payload = { event: "media", blob: "x".repeat(100) };
    const cap = 50; // far below the serialized size
    const socket = makeSocket({ bufferedAmount: 0 });
    const ok = sendJsonCapped(socket, payload, cap);
    expect(ok).toBe(false);
    const fake = socket as unknown as FakeSocket;
    expect(fake.sent).toHaveLength(0);
    expect(fake.closed?.code).toBe(1013);
  });

  it("accounts for already-buffered bytes against the cap", () => {
    const data = JSON.stringify({ event: "media" });
    const cap = Buffer.byteLength(data, "utf8") + 5;
    // Already near the cap: adding this message tips it over.
    const socket = makeSocket({ bufferedAmount: 10 });
    const ok = sendJsonCapped(socket, { event: "media" }, cap);
    expect(ok).toBe(false);
    expect((socket as unknown as FakeSocket).closed?.code).toBe(1013);
  });
});
