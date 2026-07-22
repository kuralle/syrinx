// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { PipelineBusImpl, Route, type SttReconfigurePartial } from "@kuralle-syrinx/core";
import type { ManagedSocket, SocketData, SocketFactory } from "@kuralle-syrinx/ws";
import { startStreamingSttSession } from "./session.js";
import type { SttEvent, SttWireProtocol } from "./types.js";

class FakeSocket implements ManagedSocket {
  isOpen = false;
  sent: SocketData[] = [];
  private openHandler: (() => void) | null = null;
  private messageHandler: ((data: SocketData, isBinary: boolean) => void) | null = null;
  private closeHandler: ((code: number, reason: string) => void) | null = null;
  private errorHandler: ((err: Error) => void) | null = null;
  disposeCount = 0;

  send(data: SocketData): void {
    if (!this.isOpen) throw new Error("WebSocket is not open");
    this.sent.push(data);
  }
  keepAlivePing(): void {}
  async verify(): Promise<boolean> {
    return this.isOpen;
  }
  dispose(): void {
    this.disposeCount += 1;
    this.isOpen = false;
  }
  onOpen(handler: () => void): void {
    this.openHandler = handler;
  }
  onMessage(handler: (data: SocketData, isBinary: boolean) => void): void {
    this.messageHandler = handler;
  }
  onClose(handler: (code: number, reason: string) => void): void {
    this.closeHandler = handler;
  }
  onError(handler: (err: Error) => void): void {
    this.errorHandler = handler;
  }
  openNow(): void {
    this.isOpen = true;
    this.openHandler?.();
  }
  /** Expose for reset/reconnect tests. */
  emitClose(code = 1000, reason = ""): void {
    this.isOpen = false;
    this.closeHandler?.(code, reason);
  }
  emitError(err: Error): void {
    this.errorHandler?.(err);
  }
  receive(data: SocketData, isBinary = false): void {
    this.messageHandler?.(data, isBinary);
  }
}

class SessionProtocol implements SttWireProtocol {
  openFrames: SocketData[] = [JSON.stringify({ op: "config" })];
  reconfigurePartial: SttReconfigurePartial | null = null;

  encodeFinalize(): readonly SocketData[] {
    return [];
  }

  onOpen(): readonly SocketData[] {
    return this.openFrames;
  }

  encodeReconfigure(partial: SttReconfigurePartial): readonly SocketData[] {
    this.reconfigurePartial = partial;
    return [JSON.stringify({ type: "Configure", ...partial })];
  }

  decode(data: SocketData): readonly SttEvent[] {
    if (typeof data !== "string") return [];
    const m = JSON.parse(data) as { t?: string; text?: string };
    if (m.t === "final") {
      return [{ type: "final", contextId: "", text: m.text ?? "x", speechFinal: true }];
    }
    return [];
  }
}

function makeFactory(sockets: FakeSocket[]): SocketFactory {
  return () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    // Defer past WebSocketConnection's await-continuation so onOpen is bound first.
    setTimeout(() => socket.openNow(), 0);
    return socket;
  };
}

describe("startStreamingSttSession", () => {
  it("sends onOpen frames on connect before audio replay", async () => {
    const sockets: FakeSocket[] = [];
    const bus = new PipelineBusImpl();
    const started = bus.start();
    const protocol = new SessionProtocol();

    const session = await startStreamingSttSession(bus, {
      protocol,
      provider: { name: "fake", model: "stt" },
      url: () => "ws://example.test/stt",
      socketFactory: makeFactory(sockets),
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
      format: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 },
    });

    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.sent).toEqual([JSON.stringify({ op: "config" })]);

    await session.dispose();
    bus.stop();
    await started;
  });

  it("reconfigure sends encodeReconfigure frames; reset forces a reconnect", async () => {
    const sockets: FakeSocket[] = [];
    const bus = new PipelineBusImpl();
    const started = bus.start();
    const protocol = new SessionProtocol();

    const session = await startStreamingSttSession(bus, {
      protocol,
      provider: { name: "fake", model: "stt" },
      url: () => "ws://example.test/stt",
      socketFactory: makeFactory(sockets),
      retry: { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 5 },
      format: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 },
    });

    sockets[0]!.sent = [];
    session.reconfigure({ keyterms: ["Syrinx"], eotThreshold: 0.9 });
    expect(protocol.reconfigurePartial).toEqual({ keyterms: ["Syrinx"], eotThreshold: 0.9 });
    expect(sockets[0]!.sent).toEqual([
      JSON.stringify({ type: "Configure", keyterms: ["Syrinx"], eotThreshold: 0.9 }),
    ]);

    session.reset();
    await new Promise((r) => setTimeout(r, 30));
    // reset disposes the current socket and opens a new one; onOpen re-fires.
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    expect(sockets.at(-1)!.sent).toContainEqual(JSON.stringify({ op: "config" }));

    await session.dispose();
    bus.stop();
    await started;
  });

  it("wires stt.audio through the engine and decodes finals onto the bus", async () => {
    const sockets: FakeSocket[] = [];
    const bus = new PipelineBusImpl();
    const started = bus.start();
    const protocol = new SessionProtocol();
    const results: unknown[] = [];
    bus.on("stt.result", (pkt) => {
      results.push(pkt);
    });

    const session = await startStreamingSttSession(bus, {
      protocol,
      provider: { name: "fake", model: "stt" },
      url: () => "ws://example.test/stt",
      socketFactory: makeFactory(sockets),
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
      format: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 },
    });

    bus.push(Route.Main, {
      kind: "stt.audio",
      contextId: "t1",
      timestampMs: Date.now(),
      audio: new Uint8Array(4),
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(sockets[0]!.sent.some((f) => f instanceof Uint8Array)).toBe(true);

    sockets[0]!.receive(JSON.stringify({ t: "final", text: "hello" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(results).toEqual([
      expect.objectContaining({ kind: "stt.result", contextId: "t1", text: "hello" }),
    ]);

    await session.dispose();
    bus.stop();
    await started;
  });
});
