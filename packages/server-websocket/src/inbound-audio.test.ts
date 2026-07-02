// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { encodeSyrinxAudioEnvelope } from "@kuralle-syrinx/core";
import { decodeInboundBinaryAudio, resampleAudioBytes, type OpusIngressDecoder } from "./inbound-audio.js";

// Regression for the opus mic-uplink double-resample P0: opus ingress is decoded
// AND resampled to the engine rate inside decodeInboundBinaryAudio, so it must
// report the ENGINE rate — not the 48 kHz header rate — or the caller resamples
// the already-16 kHz audio a second time and delivers ~1/3 the samples (3× fast).
describe("decodeInboundBinaryAudio opus rate", () => {
  const ENGINE_RATE = 16000;
  const WIRE_RATE = 48000;

  // A fake opus decoder returning PCM at the opus native rate (48 kHz), as the real
  // decoder does. decodeInboundBinaryAudio then resamples it ONCE to the engine rate.
  // 20 ms at 48 kHz mono PCM16 = 960 samples = 1920 bytes → 320 samples = 640 bytes @ 16 kHz.
  const opusNativePcm = new Uint8Array(1920);
  const fakeOpusDecoder: OpusIngressDecoder = () => opusNativePcm;

  function opusEnvelope(): Uint8Array {
    // The opus payload bytes are opaque to the decoder mock.
    const opusPayload = new Uint8Array([1, 2, 3, 4]);
    return encodeSyrinxAudioEnvelope(
      {
        type: "audio",
        contextId: "turn-1",
        sampleRateHz: WIRE_RATE,
        sequence: 1,
        encoding: "opus",
        channels: 1,
        byteLength: opusPayload.byteLength,
        durationMs: 20,
      },
      opusPayload,
    );
  }

  it("reports the engine rate, not the header rate, so the caller does not resample again", () => {
    const decoded = decodeInboundBinaryAudio(
      opusEnvelope(),
      ENGINE_RATE,
      false,
      ENGINE_RATE,
      new Map(),
      fakeOpusDecoder,
    );

    // Decoded once from 48 kHz → 16 kHz inside decodeInboundBinaryAudio: 640 bytes.
    expect(decoded.sampleRateHz).toBe(ENGINE_RATE);
    expect(decoded.audio.byteLength).toBe(640);

    // The caller's final resample (reported rate → engine rate) is now an identity:
    // 320 samples in, 320 samples out (not ~107 as under the old 48 kHz label → 3× fast).
    const final = resampleAudioBytes(decoded.audio, decoded.sampleRateHz, ENGINE_RATE, new Map());
    expect(final.byteLength).toBe(640);
  });
});
