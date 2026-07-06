// SPDX-License-Identifier: MIT
//
// VE-06.2: reconnect replay. A frame whose send() fails because the socket is not open
// (provably never reached the wire) is buffered and re-sent in order on reconnect; frames
// sent on an open socket are never buffered, so received frames are never duplicated.

import { describe, expect, it } from "vitest";
import type { RetryConfig } from "@kuralle-syrinx/core";

import { WebSocketConnection, type ManagedSocket, type SocketData } from "./index.js";
import { wrapWebSocket, type WebSocketEventLike, type WebSocketLike } from "./web-socket.js";

const FAST_RETRY: RetryConfig = { maxAttempts: 5, baseDelayMs: 5, maxDelayMs: 20 };

class FakeWebSocket implements WebSocketLike {
  readyState = 0;
  binaryType = "blob";
  readonly sent: SocketData[] = [];
  private readonly listeners = new Map<string, Array<(event: WebSocketEventLike) => void>>();
  send(data: string | ArrayBufferView | ArrayBuffer): void {
    this.sent.push(typeof data === "string" ? data : new Uint8Array(data as ArrayBuffer));
  }
  close(): void { this.readyState = 3; this.emit("close", { code: 1006, reason: "drop" }); }
  addEventListener(type: string, l: (e: WebSocketEventLike) => void): void {
    const list = this.listeners.get(type) ?? []; list.push(l); this.listeners.set(type, list);
  }
  private emit(type: string, event: WebSocketEventLike): void { for (const l of this.listeners.get(type) ?? []) l(event); }
  fireOpen(): void { this.readyState = 1; this.emit("open", {}); }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("WebSocketConnection reconnect replay (VE-06.2)", () => {
  it("send() to a closed socket throws when replay is disabled (default)", async () => {
    const fake = new FakeWebSocket();
    const conn = new WebSocketConnection({
      url: () => "wss://x", socketFactory: () => wrapWebSocket(fake), retry: FAST_RETRY,
      onMessage: () => undefined,
    });
    const connected = conn.connect(); fake.fireOpen(); await connected;
    fake.readyState = 3; // simulate closed
    expect(() => conn.send("frame")).toThrow(/not open/);
    await conn.close();
  });

  it("buffers gap frames and replays them in order on reconnect; on-wire frames are not replayed", async () => {
    const fakes: FakeWebSocket[] = [];
    const replayEvents: Array<{ event: string; count: number }> = [];
    const conn = new WebSocketConnection({
      url: () => "wss://x",
      socketFactory: () => { const f = new FakeWebSocket(); fakes.push(f); return wrapWebSocket(f); },
      retry: FAST_RETRY,
      replayBufferSize: 10,
      onReplay: (event, count) => replayEvents.push({ event, count }),
      onMessage: () => undefined,
    });

    const connected = conn.connect();
    fakes[0]!.fireOpen();
    await connected;

    conn.send("on-wire-1"); // sent on the open socket — must NOT be replayed
    expect(fakes[0]!.sent).toEqual(["on-wire-1"]);

    // Connection drops → reconnect begins.
    fakes[0]!.close();
    // During the gap (socket not open) the caller keeps sending — these buffer for replay.
    conn.send("gap-1");
    conn.send("gap-2");

    // Wait for the reconnect to create a new socket, then open it.
    await wait(40);
    expect(fakes.length).toBeGreaterThanOrEqual(2);
    fakes[fakes.length - 1]!.fireOpen();
    await wait(10);

    const reconnected = fakes[fakes.length - 1]!;
    // The two gap frames are replayed in order on the new socket; the on-wire frame is NOT.
    expect(reconnected.sent).toEqual(["gap-1", "gap-2"]);
    expect(replayEvents.filter((e) => e.event === "replayed")).toHaveLength(1);
    expect(replayEvents.find((e) => e.event === "replayed")?.count).toBe(2);

    await conn.close();
  });

  it("buffers frames sent during the reconnect verify window until after onReadyBeforeReplay", async () => {
    // The provider-facing contract: on a fresh connection, the config frame
    // (sent by onReadyBeforeReplay) reaches the wire before any caller frame.
    // A send() landing between socket-open and verify completion must buffer,
    // not pass through — otherwise config-first providers see audio first.
    class HeldVerifySocket implements ManagedSocket {
      isOpen = false;
      readonly sent: SocketData[] = [];
      readonly supportsFramePing = true;
      resolveVerify: ((ok: boolean) => void) | null = null;
      private openHandler: (() => void) | null = null;
      private closeHandler: ((code: number, reason: string) => void) | null = null;
      send(data: SocketData): void { this.sent.push(data); }
      keepAlivePing(): void {}
      verify(): Promise<boolean> {
        return new Promise((resolve) => { this.resolveVerify = resolve; });
      }
      dispose(): void {}
      onOpen(h: () => void): void { this.openHandler = h; }
      onMessage(): void {}
      onClose(h: (code: number, reason: string) => void): void { this.closeHandler = h; }
      onError(): void {}
      fireOpen(): void { this.isOpen = true; this.openHandler?.(); }
      fireClose(): void { this.isOpen = false; this.closeHandler?.(1006, "drop"); }
    }

    const sockets: HeldVerifySocket[] = [];
    const conn = new WebSocketConnection({
      url: () => "wss://x",
      socketFactory: () => {
        const s = new HeldVerifySocket();
        sockets.push(s);
        setTimeout(() => s.fireOpen(), 0);
        return s;
      },
      retry: FAST_RETRY,
      replayBufferSize: 10,
      onReadyBeforeReplay: () => conn.send("config"),
      onMessage: () => undefined,
    });

    await conn.connect();
    expect(sockets[0]!.sent).toEqual(["config"]);

    // Drop the link → reconnect opens socket 2, then awaits verify (held open).
    sockets[0]!.fireClose();
    await wait(40);
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    const second = sockets[sockets.length - 1]!;
    expect(second.isOpen).toBe(true);
    expect(second.resolveVerify).not.toBeNull();

    // Caller sends while the link is open but NOT yet verified/configured.
    conn.send("audio-during-verify");
    expect(second.sent).toEqual([]); // must buffer, not hit the wire

    second.resolveVerify!(true);
    await wait(10);
    expect(second.sent).toEqual(["config", "audio-during-verify"]);

    await conn.close();
  });

  it("bounds the replay buffer, dropping oldest with an overflow signal", async () => {
    const fake = new FakeWebSocket();
    const events: string[] = [];
    const conn = new WebSocketConnection({
      url: () => "wss://x", socketFactory: () => wrapWebSocket(fake), retry: FAST_RETRY,
      replayBufferSize: 2, onReplay: (e) => events.push(e), onMessage: () => undefined,
    });
    const connected = conn.connect(); fake.fireOpen(); await connected;
    fake.readyState = 3; // closed
    conn.send("a"); conn.send("b"); conn.send("c"); // buffer holds last 2 → "a" overflows
    expect(events.filter((e) => e === "overflow")).toHaveLength(1);
    await conn.close();
  });
});
