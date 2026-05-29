// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
  SYRINX_AUDIO_ENVELOPE_MAGIC,
  decodeSyrinxAudioEnvelope,
  encodeSyrinxAudioEnvelope,
  hasSyrinxAudioEnvelope,
} from "./audio-envelope.js";
import type { SyrinxAudioEnvelopeHeader } from "./audio-envelope.js";

describe("Syrinx binary audio envelope", () => {
  it("round-trips audio metadata and payload", () => {
    const encoded = encodeSyrinxAudioEnvelope({
      type: "audio",
      contextId: "turn-1",
      sampleRateHz: 16000,
      sequence: 3,
      encoding: "pcm_s16le",
      channels: 1,
      byteLength: 4,
      durationMs: 1,
    }, new Uint8Array([1, 2, 3, 4]));

    expect(hasSyrinxAudioEnvelope(encoded)).toBe(true);
    expect(decodeSyrinxAudioEnvelope(encoded)).toEqual({
      header: {
        type: "audio",
        contextId: "turn-1",
        sampleRateHz: 16000,
        sequence: 3,
        encoding: "pcm_s16le",
        channels: 1,
        byteLength: 4,
        durationMs: 1,
      },
      audio: new Uint8Array([1, 2, 3, 4]),
    });
  });

  it("rejects envelopes whose declared byte length does not match the payload", () => {
    const encoded = encodeMalformedSyrinxAudioEnvelope({
      type: "audio",
      sampleRateHz: 16000,
      byteLength: 5,
    }, new Uint8Array([1, 2, 3, 4]));

    expect(() => decodeSyrinxAudioEnvelope(encoded)).toThrow(/byteLength/);
  });

  it("rejects odd-byte PCM16 payloads and inconsistent duration metadata", () => {
    const oddPayload = encodeMalformedSyrinxAudioEnvelope({
      type: "audio",
      sampleRateHz: 16000,
      byteLength: 3,
    }, new Uint8Array([1, 2, 3]));
    const wrongDuration = encodeMalformedSyrinxAudioEnvelope({
      type: "audio",
      sampleRateHz: 16000,
      byteLength: 640,
      durationMs: 200,
    }, new Uint8Array(640));

    expect(() => decodeSyrinxAudioEnvelope(oddPayload)).toThrow(/PCM16/);
    expect(() => decodeSyrinxAudioEnvelope(wrongDuration)).toThrow(/durationMs/);
  });

  it("rejects envelopes without a valid sample rate", () => {
    const missingSampleRate = encodeMalformedSyrinxAudioEnvelope({
      type: "audio",
      byteLength: 4,
    }, new Uint8Array([1, 2, 3, 4]));
    const invalidSampleRate = encodeMalformedSyrinxAudioEnvelope({
      type: "audio",
      sampleRateHz: 0,
      byteLength: 4,
    }, new Uint8Array([1, 2, 3, 4]));

    expect(() => decodeSyrinxAudioEnvelope(missingSampleRate)).toThrow(/sampleRateHz/);
    expect(() => decodeSyrinxAudioEnvelope(invalidSampleRate)).toThrow(/sampleRateHz/);
  });

  it("rejects malformed numeric metadata instead of silently defaulting", () => {
    const invalidSequence = encodeMalformedSyrinxAudioEnvelope({
      type: "audio",
      sampleRateHz: 16000,
      sequence: -1,
      byteLength: 4,
    }, new Uint8Array([1, 2, 3, 4]));
    const invalidDuration = encodeMalformedSyrinxAudioEnvelope({
      type: "audio",
      sampleRateHz: 16000,
      durationMs: 1.5,
      byteLength: 4,
    }, new Uint8Array([1, 2, 3, 4]));

    expect(() => decodeSyrinxAudioEnvelope(invalidSequence)).toThrow(/sequence/);
    expect(() => decodeSyrinxAudioEnvelope(invalidDuration)).toThrow(/durationMs/);
  });

  it("rejects invalid envelopes before encoding them", () => {
    expect(() => encodeSyrinxAudioEnvelope({
      type: "audio",
      byteLength: 4,
    } as SyrinxAudioEnvelopeHeader, new Uint8Array([1, 2, 3, 4]))).toThrow(/sampleRateHz/);
    expect(() => encodeSyrinxAudioEnvelope({
      type: "audio",
      sampleRateHz: 16000,
      sequence: -1,
      byteLength: 4,
    }, new Uint8Array([1, 2, 3, 4]))).toThrow(/sequence/);
    expect(() => encodeSyrinxAudioEnvelope({
      type: "audio",
      sampleRateHz: 16000,
      byteLength: 5,
    }, new Uint8Array([1, 2, 3, 4]))).toThrow(/byteLength/);
  });
});

function encodeMalformedSyrinxAudioEnvelope(header: Record<string, unknown>, audio: Uint8Array): Uint8Array {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const output = new Uint8Array(SYRINX_AUDIO_ENVELOPE_MAGIC.byteLength + 4 + headerBytes.byteLength + audio.byteLength);
  output.set(SYRINX_AUDIO_ENVELOPE_MAGIC, 0);
  new DataView(output.buffer, output.byteOffset, output.byteLength)
    .setUint32(SYRINX_AUDIO_ENVELOPE_MAGIC.byteLength, headerBytes.byteLength, true);
  output.set(headerBytes, SYRINX_AUDIO_ENVELOPE_MAGIC.byteLength + 4);
  output.set(audio, SYRINX_AUDIO_ENVELOPE_MAGIC.byteLength + 4 + headerBytes.byteLength);
  return output;
}
