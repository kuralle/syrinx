// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { decodeSyrinxAudioEnvelope, encodeSyrinxAudioEnvelope, hasSyrinxAudioEnvelope } from "./audio-envelope.js";

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
    const encoded = encodeSyrinxAudioEnvelope({
      type: "audio",
      sampleRateHz: 16000,
      byteLength: 5,
    }, new Uint8Array([1, 2, 3, 4]));

    expect(() => decodeSyrinxAudioEnvelope(encoded)).toThrow(/byteLength/);
  });

  it("rejects odd-byte PCM16 payloads and inconsistent duration metadata", () => {
    const oddPayload = encodeSyrinxAudioEnvelope({
      type: "audio",
      sampleRateHz: 16000,
      byteLength: 3,
    }, new Uint8Array([1, 2, 3]));
    const wrongDuration = encodeSyrinxAudioEnvelope({
      type: "audio",
      sampleRateHz: 16000,
      byteLength: 640,
      durationMs: 200,
    }, new Uint8Array(640));

    expect(() => decodeSyrinxAudioEnvelope(oddPayload)).toThrow(/PCM16/);
    expect(() => decodeSyrinxAudioEnvelope(wrongDuration)).toThrow(/durationMs/);
  });

  it("rejects envelopes without a valid sample rate", () => {
    const missingSampleRate = encodeSyrinxAudioEnvelope({
      type: "audio",
      byteLength: 4,
    }, new Uint8Array([1, 2, 3, 4]));
    const invalidSampleRate = encodeSyrinxAudioEnvelope({
      type: "audio",
      sampleRateHz: 0,
      byteLength: 4,
    }, new Uint8Array([1, 2, 3, 4]));

    expect(() => decodeSyrinxAudioEnvelope(missingSampleRate)).toThrow(/sampleRateHz/);
    expect(() => decodeSyrinxAudioEnvelope(invalidSampleRate)).toThrow(/sampleRateHz/);
  });

  it("rejects malformed numeric metadata instead of silently defaulting", () => {
    const invalidSequence = encodeSyrinxAudioEnvelope({
      type: "audio",
      sampleRateHz: 16000,
      sequence: -1,
      byteLength: 4,
    }, new Uint8Array([1, 2, 3, 4]));
    const invalidDuration = encodeSyrinxAudioEnvelope({
      type: "audio",
      sampleRateHz: 16000,
      durationMs: 1.5,
      byteLength: 4,
    }, new Uint8Array([1, 2, 3, 4]));

    expect(() => decodeSyrinxAudioEnvelope(invalidSequence)).toThrow(/sequence/);
    expect(() => decodeSyrinxAudioEnvelope(invalidDuration)).toThrow(/durationMs/);
  });
});
