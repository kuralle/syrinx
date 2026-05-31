// SPDX-License-Identifier: MIT

import { Decoder as OpusDecoder, Encoder as OpusEncoder } from "@evan/opus";
import { pcm16BytesToSamples, pcm16SamplesToBytes } from "@asyncdot/voice/audio";

export const BROWSER_OPUS_SAMPLE_RATE_HZ = 48_000;
export const BROWSER_OPUS_FRAME_DURATION_MS = 20;

export type BrowserOpusCodec = {
  readonly sampleRateHz: number;
  readonly frameSamples: number;
  encodePcm16Frame(samples: Int16Array, flush?: boolean): Uint8Array[];
  decodeOpusFrame(wire: Uint8Array): Int16Array;
  reset(): void;
};

export function createBrowserOpusCodec(sampleRateHz = BROWSER_OPUS_SAMPLE_RATE_HZ): BrowserOpusCodec {
  const encoder = new OpusEncoder({ channels: 1, sample_rate: sampleRateHz as 48000, application: "voip" });
  const decoder = new OpusDecoder({ channels: 1, sample_rate: sampleRateHz as 48000 });
  const frameSamples = Math.max(1, Math.round((sampleRateHz * BROWSER_OPUS_FRAME_DURATION_MS) / 1000));
  let encodeRemainder = new Int16Array(0);

  return {
    sampleRateHz,
    frameSamples,
    reset() {
      encodeRemainder = new Int16Array(0);
    },
    decodeOpusFrame(wire: Uint8Array): Int16Array {
      return pcm16BytesToSamples(decoder.decode(wire));
    },
    encodePcm16Frame(samples: Int16Array, flush = false): Uint8Array[] {
      const pending = new Int16Array(encodeRemainder.length + samples.length);
      pending.set(encodeRemainder);
      pending.set(samples, encodeRemainder.length);
      const completeFrames = Math.floor(pending.length / frameSamples);
      const frames: Uint8Array[] = [];
      for (let index = 0; index < completeFrames; index += 1) {
        const frame = pending.subarray(index * frameSamples, (index + 1) * frameSamples);
        frames.push(encoder.encode(pcm16SamplesToBytes(frame)));
      }
      const consumed = completeFrames * frameSamples;
      const remainder = pending.subarray(consumed);
      if (flush && remainder.length > 0) {
        const padded = new Int16Array(frameSamples);
        padded.set(remainder);
        frames.push(encoder.encode(pcm16SamplesToBytes(padded)));
        encodeRemainder = new Int16Array(0);
      } else {
        encodeRemainder = new Int16Array(remainder);
      }
      return frames;
    },
  };
}

export function decodeBrowserOpusToPcm16Bytes(wire: Uint8Array, codec: BrowserOpusCodec): Uint8Array {
  return pcm16SamplesToBytes(codec.decodeOpusFrame(wire));
}
