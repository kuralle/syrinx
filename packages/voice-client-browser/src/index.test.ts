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
  private readonly listeners = new Map<string, Array<(event: any) => void>>();

  constructor(
    readonly url: string | URL,
    readonly protocols?: string | string[],
  ) {
    sockets.push(this);
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  dispatch(type: string, event: any): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
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

  it("rejects duplicate or regressing explicit audio sequence overrides before sending", () => {
    const client = new SyrinxBrowserClient({ url: "ws://localhost/ws" });
    client.connect();
    const socket = sockets[0]!;

    client.sendAudioBase64(Buffer.from([1, 0, 2, 0]).toString("base64"), 16000, {
      contextId: "turn-json",
      sequence: 3,
    });

    expect(() => client.sendAudioPcm(new Uint8Array([3, 0, 4, 0]), 16000, {
      contextId: "turn-pcm",
      sequence: 3,
    })).toThrow("audio sequence must increase monotonically: 3 -> 3");
    expect(() => client.sendFloat32Audio(new Float32Array([0, 0.5, 1]), {
      fromSampleRateHz: 48000,
      toSampleRateHz: 16000,
      contextId: "turn-float",
      sequence: 2,
    })).toThrow("audio sequence must increase monotonically: 3 -> 2");

    expect(socket.sent).toHaveLength(1);
  });

  it("emits validated server JSON messages", () => {
    const client = new SyrinxBrowserClient({ url: "ws://localhost/ws" });
    const messages: unknown[] = [];
    client.on((event) => {
      if (event.type === "message") messages.push(event.message);
    });
    client.connect();

    sockets[0]!.dispatch("message", {
      data: JSON.stringify({
        type: "tts_chunk",
        turnId: "turn-1",
        sequence: 1,
        sampleRateHz: 16000,
        encoding: "pcm_s16le",
        channels: 1,
        byteLength: 320,
        durationMs: 10,
      }),
    });

    expect(messages).toEqual([
      {
        type: "tts_chunk",
        turnId: "turn-1",
        sequence: 1,
        sampleRateHz: 16000,
        encoding: "pcm_s16le",
        channels: 1,
        byteLength: 320,
        durationMs: 10,
      },
    ]);
  });

  it("surfaces malformed server JSON messages as client errors", () => {
    const client = new SyrinxBrowserClient({ url: "ws://localhost/ws" });
    const messages: unknown[] = [];
    const errors: string[] = [];
    client.on((event) => {
      if (event.type === "message") messages.push(event.message);
      if (event.type === "error" && event.error instanceof Error) errors.push(event.error.message);
    });
    client.connect();

    sockets[0]!.dispatch("message", {
      data: JSON.stringify({
        type: "agent_chunk",
        turnId: "turn-1",
        text: 42,
      }),
    });

    expect(messages).toEqual([]);
    expect(errors).toEqual(["agent_chunk.text must be a non-empty string"]);
  });
});
