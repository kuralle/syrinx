// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Decoder as OpusDecoder, Encoder as OpusEncoder } from "@evan/opus";
import { decodeSyrinxAudioEnvelope } from "@asyncdot/voice";
import { pcm16BytesToSamples, pcm16SamplesToBytes } from "@asyncdot/voice/audio";
import { SyrinxBrowserClient } from "./index.js";
import type { ClientTransport, ClientTransportHandlers } from "./transport.js";
import { pickBrowserWireCodec, createBrowserOpusCodec } from "./browser-opus.js";

class FakeTransport implements ClientTransport {
  readonly sent: unknown[] = [];
  private handlers: ClientTransportHandlers = {};
  private open = false;

  get connected(): boolean {
    return this.open;
  }

  setHandlers(handlers: ClientTransportHandlers): void {
    this.handlers = handlers;
  }

  connect(_url: string): void {
    this.open = true;
    this.handlers.onOpen?.();
  }

  disconnect(): void {
    this.open = false;
    this.handlers.onClose?.(1000, "");
  }

  sendAudio(data: Uint8Array | ArrayBuffer): void {
    this.sent.push(data);
  }

  sendJson(value: unknown): void {
    this.sent.push(JSON.stringify(value));
  }

  emitMessage(data: string): void {
    this.handlers.onMessage?.(data);
  }

  emitAudio(data: ArrayBuffer): void {
    this.handlers.onAudio?.(data);
  }
}

describe("ClientTransport seam", () => {
  it("drives SyrinxBrowserClient through an injected fake transport", () => {
    const transport = new FakeTransport();
    const client = new SyrinxBrowserClient({
      url: "ws://unused/ws",
      transport,
      reconnect: false,
      keepaliveIntervalMs: false,
    });
    const events: string[] = [];
    client.on((event) => events.push(event.type));
    client.connect();

    expect(events).toContain("open");
    transport.emitMessage(JSON.stringify({
      type: "ready",
      sessionId: "sess-fake",
      audio: {
        inputSampleRateHz: 16000,
        outputSampleRateHz: 16000,
        encoding: "pcm_s16le",
        channels: 1,
      },
    }));
    client.sendAudioPcm(new Uint8Array([1, 0, 2, 0]), 16000);
    expect(transport.sent.length).toBeGreaterThan(0);
  });
});

describe("browser opus negotiation", () => {
  it("prefers opus when the server advertises it", () => {
    expect(pickBrowserWireCodec(["pcm_s16le", "opus"], true)).toBe("opus");
    expect(pickBrowserWireCodec(["pcm_s16le", "opus"], false)).toBe("pcm_s16le");
    expect(pickBrowserWireCodec(["pcm_s16le"], true)).toBe("pcm_s16le");
  });

  it("produces opus frames and decodes them back to PCM16 samples", async () => {
    const codec = await createBrowserOpusCodec(48000);
    const pcm = new Int16Array(960);
    pcm[0] = 1000;
    const wire = codec.encodePcm16Frame(pcm, true)[0]!;
    expect(wire.byteLength).toBeGreaterThan(0);
    expect(codec.decodeOpusFrame(wire).length).toBeGreaterThan(0);
  });

  it("encodes uplink envelopes as opus after ready negotiation", async () => {
    const transport = new FakeTransport();
    const client = new SyrinxBrowserClient({
      url: "ws://unused/ws",
      transport,
      reconnect: false,
      keepaliveIntervalMs: false,
    });
    client.connect();
    transport.emitMessage(JSON.stringify({
      type: "ready",
      sessionId: "sess-opus",
      audio: {
        inputSampleRateHz: 16000,
        outputSampleRateHz: 16000,
        encoding: "opus",
        supportedInputCodecs: ["pcm_s16le", "opus"],
        channels: 1,
        binaryEnvelope: "syrinx.audio.v1",
      },
    }));

    await vi.waitFor(() => transport.sent.length > 0, { timeout: 50 }).catch(() => undefined);

    const pcm = new Uint8Array(640);
    pcm[0] = 1;
    pcm[1] = 0;
    client.sendAudioPcm(pcm, 16000, { contextId: "turn-opus" });

    await vi.waitFor(() => transport.sent.some((entry) => {
      if (!(entry instanceof Uint8Array)) return false;
      return decodeSyrinxAudioEnvelope(entry).header.encoding === "opus";
    }), { timeout: 3_000 });

    const envelopeBytes = transport.sent.find((entry): entry is Uint8Array => {
      if (!(entry instanceof Uint8Array)) return false;
      return decodeSyrinxAudioEnvelope(entry).header.encoding === "opus";
    })!;
    const envelope = decodeSyrinxAudioEnvelope(envelopeBytes);
    expect(envelope.header.sampleRateHz).toBe(48000);
    const reference = pcm16BytesToSamples(
      new OpusDecoder({ channels: 1, sample_rate: 48000 }).decode(envelope.audio),
    );
    expect(reference.length).toBeGreaterThan(0);
  });
});
