// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { encodeSyrinxAudioEnvelope } from "@asyncdot/voice";
import {
  decodeBrowserAssistantAudio,
  encodeBrowserAudioEnvelopeFrame,
  encodeBrowserAudioFrame,
  float32ToPcm16,
  pcm16FrameSampleCount,
  resampleFloat32Linear,
} from "./audio.js";

describe("browser audio utilities", () => {
  it("resamples 48 kHz microphone input to 16 kHz PCM without trusting AudioContext rate", () => {
    const input = new Float32Array(480);
    for (let i = 0; i < input.length; i += 1) input[i] = i / input.length;

    const output = resampleFloat32Linear(input, {
      fromSampleRateHz: 48000,
      toSampleRateHz: 16000,
    });

    expect(output.length).toBe(160);
    expect(output[0]).toBeCloseTo(0);
    expect(output[1]).toBeCloseTo(input[3]!);
    expect(output.at(-1)).toBeCloseTo(input[477]!);
  });

  it("resamples 44.1 kHz microphone input to 16 kHz with stable frame sizing", () => {
    const input = new Float32Array(441);
    input.fill(0.25);

    const output = resampleFloat32Linear(input, {
      fromSampleRateHz: 44100,
      toSampleRateHz: 16000,
    });

    expect(output.length).toBe(160);
    expect(pcm16FrameSampleCount(16000)).toBe(320);
    expect(output.every((sample) => Math.abs(sample - 0.25) < 0.0001)).toBe(true);
  });

  it("encodes browser Float32 audio as turn-scoped 16 kHz PCM16 JSON frames", () => {
    const frame = encodeBrowserAudioFrame(new Float32Array([-2, -1, 0, 0.5, 1, 2]), {
      fromSampleRateHz: 48000,
      toSampleRateHz: 16000,
      contextId: "review-turn",
    });
    const bytes = Buffer.from(frame.audio, "base64");
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);

    expect(frame).toMatchObject({
      type: "audio",
      contextId: "review-turn",
      sampleRateHz: 16000,
    });
    expect(Array.from(pcm)).toEqual([-32768, 16384]);
  });

  it("encodes browser Float32 audio as turn-scoped binary envelope frames", () => {
    const frame = encodeBrowserAudioEnvelopeFrame(new Float32Array([-2, -1, 0, 0.5, 1, 2]), {
      fromSampleRateHz: 48000,
      toSampleRateHz: 16000,
      contextId: "review-turn",
      sequence: 9,
    });

    const decoded = decodeBrowserAssistantAudio(frame);
    const bytes = new Uint8Array(decoded.data);
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);

    expect(decoded.metadata).toMatchObject({
      type: "audio",
      contextId: "review-turn",
      sampleRateHz: 16000,
      sequence: 9,
      encoding: "pcm_s16le",
      channels: 1,
      byteLength: 4,
    });
    expect(Array.from(pcm)).toEqual([-32768, 16384]);
  });

  it("clamps Float32 samples before PCM16 conversion", () => {
    expect(Array.from(float32ToPcm16(new Float32Array([-1.5, -1, 0, 1, 1.5])))).toEqual([
      -32768,
      -32768,
      0,
      32767,
      32767,
    ]);
  });

  it("decodes enveloped assistant audio before playback", () => {
    const encoded = encodeSyrinxAudioEnvelope({
      type: "audio",
      contextId: "turn-tts",
      sampleRateHz: 16000,
      sequence: 2,
      byteLength: 4,
    }, new Uint8Array([1, 2, 3, 4]));

    const decoded = decodeBrowserAssistantAudio(encoded);

    expect(new Uint8Array(decoded.data)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(decoded.metadata).toMatchObject({
      contextId: "turn-tts",
      sampleRateHz: 16000,
      sequence: 2,
    });
  });
});
