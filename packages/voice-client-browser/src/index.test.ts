// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeSyrinxAudioEnvelope } from "@asyncdot/voice";
import { SyrinxBrowserClient } from "./index.js";

const originalWebSocket = globalThis.WebSocket;
let sockets: FakeWebSocket[] = [];

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  binaryType: BinaryType = "blob";
  readyState = FakeWebSocket.OPEN;
  readonly sent: unknown[] = [];

  constructor(
    readonly url: string | URL,
    readonly protocols?: string | string[],
  ) {
    sockets.push(this);
  }

  addEventListener(): void {
    return;
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

describe("SyrinxBrowserClient", () => {
  beforeEach(() => {
    sockets = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  it("adds monotonic sequence metadata to every audio send path by default", () => {
    const client = new SyrinxBrowserClient({ url: "ws://localhost/ws" });
    client.connect();
    const socket = sockets[0]!;

    client.sendAudioBase64(Buffer.from([1, 0, 2, 0]).toString("base64"), 16000, { contextId: "turn-json" });
    client.sendAudioPcm(new Uint8Array([3, 0, 4, 0]), 16000, { contextId: "turn-pcm" });
    client.sendFloat32Audio(new Float32Array([0, 0.5, 1]), {
      fromSampleRateHz: 48000,
      toSampleRateHz: 16000,
      contextId: "turn-float",
    });

    const jsonAudio = JSON.parse(socket.sent[0] as string) as { readonly sequence?: number };
    const pcmEnvelope = decodeSyrinxAudioEnvelope(socket.sent[1] as Uint8Array);
    const floatEnvelope = decodeSyrinxAudioEnvelope(socket.sent[2] as Uint8Array);

    expect(jsonAudio.sequence).toBe(1);
    expect(pcmEnvelope.header).toMatchObject({ contextId: "turn-pcm", sequence: 2 });
    expect(floatEnvelope.header).toMatchObject({ contextId: "turn-float", sequence: 3 });
  });

  it("honors explicit audio sequence overrides and advances later automatic sequences past them", () => {
    const client = new SyrinxBrowserClient({ url: "ws://localhost/ws" });
    client.connect();
    const socket = sockets[0]!;

    client.sendAudioPcm(new Uint8Array([1, 0, 2, 0]), 16000, { contextId: "turn-pcm", sequence: 10 });
    client.sendFloat32Audio(new Float32Array([0, 0.5, 1]), {
      fromSampleRateHz: 48000,
      toSampleRateHz: 16000,
      contextId: "turn-float",
    });

    const pcmEnvelope = decodeSyrinxAudioEnvelope(socket.sent[0] as Uint8Array);
    const floatEnvelope = decodeSyrinxAudioEnvelope(socket.sent[1] as Uint8Array);

    expect(pcmEnvelope.header).toMatchObject({ contextId: "turn-pcm", sequence: 10 });
    expect(floatEnvelope.header).toMatchObject({ contextId: "turn-float", sequence: 11 });
  });
});
