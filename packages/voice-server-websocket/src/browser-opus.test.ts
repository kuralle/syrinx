// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { Decoder as OpusDecoder, Encoder as OpusEncoder } from "@evan/opus";
import { pcm16BytesToSamples, pcm16SamplesToBytes } from "@asyncdot/voice/audio";
import { BROWSER_OPUS_FRAME_DURATION_MS, createBrowserOpusCodec } from "./browser-opus.js";

describe("browser opus codec", () => {
  it("produces non-empty opus frames and decodes them back to PCM16 bytes", () => {
    const pcm = new Int16Array(960);
    pcm[0] = 1000;
    pcm[3] = -1000;
    const encoder = new OpusEncoder({ channels: 1, sample_rate: 48000, application: "voip" });
    const decoder = new OpusDecoder({ channels: 1, sample_rate: 48000 });
    const opus = encoder.encode(pcm16SamplesToBytes(pcm));
    expect(opus.byteLength).toBeGreaterThan(0);
    const decoded = pcm16BytesToSamples(decoder.decode(opus));
    expect(decoded.length).toBeGreaterThan(0);

    const codec = createBrowserOpusCodec(48000);
    const wire = codec.encodePcm16Frame(pcm, true)[0]!;
    expect(wire.byteLength).toBeGreaterThan(0);
    expect(codec.decodeOpusFrame(wire).length).toBeGreaterThan(0);
  });

  it("accumulates partial PCM before emitting a complete opus frame", () => {
    const codec = createBrowserOpusCodec(48000);
    const half = new Int16Array(Math.round((48000 * BROWSER_OPUS_FRAME_DURATION_MS) / 2000));
    expect(codec.encodePcm16Frame(half, false)).toEqual([]);
    const full = codec.encodePcm16Frame(half, true);
    expect(full.length).toBeGreaterThan(0);
  });
});
