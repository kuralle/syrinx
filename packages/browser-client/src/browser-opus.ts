// SPDX-License-Identifier: MIT

import { encodeSyrinxAudioEnvelope } from "@kuralle-syrinx/core";
import { pcm16BytesToSamples, pcm16SamplesToBytes } from "@kuralle-syrinx/core/audio";

export const BROWSER_OPUS_SAMPLE_RATE_HZ = 48_000;
export const BROWSER_OPUS_FRAME_DURATION_MS = 20;
export const BROWSER_SUPPORTED_INPUT_CODECS = ["pcm_s16le", "opus"] as const;

export type BrowserWireCodec = "pcm_s16le" | "opus";

type OpusEncoder = { encode(pcm: Uint8Array): Uint8Array };
type OpusDecoder = { decode(opus: Uint8Array): Uint8Array };

type OpusModule = {
  readonly Encoder: new (options: { channels: 1; sample_rate: number; application: "voip" }) => OpusEncoder;
  readonly Decoder: new (options: { channels: 1; sample_rate: number }) => OpusDecoder;
};

export interface BrowserOpusCodec {
  readonly sampleRateHz: number;
  readonly frameSamples: number;
  encodePcm16Frame(samples: Int16Array, flush?: boolean): Uint8Array[];
  decodeOpusFrame(wire: Uint8Array): Int16Array;
  reset(): void;
}

let opusModulePromise: Promise<OpusModule> | null = null;

export function loadBrowserOpusModule(): Promise<OpusModule> {
  opusModulePromise ??= import("@evan/opus") as Promise<OpusModule>;
  return opusModulePromise;
}

export async function createBrowserOpusCodec(
  sampleRateHz = BROWSER_OPUS_SAMPLE_RATE_HZ,
): Promise<BrowserOpusCodec> {
  const { Encoder, Decoder } = await loadBrowserOpusModule();
  const encoder = new Encoder({ channels: 1, sample_rate: sampleRateHz, application: "voip" });
  const decoder = new Decoder({ channels: 1, sample_rate: sampleRateHz });
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

export function pickBrowserWireCodec(
  supportedInputCodecs: readonly string[] | undefined,
  opusAvailable: boolean,
): BrowserWireCodec {
  if (opusAvailable && supportedInputCodecs?.includes("opus")) return "opus";
  return "pcm_s16le";
}

export function encodeBrowserOpusEnvelope(
  opusPayload: Uint8Array,
  sampleRateHz: number,
  options: { readonly contextId?: string; readonly sequence?: number },
): Uint8Array {
  return encodeSyrinxAudioEnvelope({
    type: "audio",
    contextId: options.contextId,
    sampleRateHz,
    sequence: options.sequence,
    encoding: "opus",
    channels: 1,
    byteLength: opusPayload.byteLength,
    durationMs: BROWSER_OPUS_FRAME_DURATION_MS,
  }, opusPayload);
}

export function encodeBrowserPcmEnvelope(
  audio: Uint8Array,
  sampleRateHz: number,
  options: { readonly contextId?: string; readonly sequence?: number },
): Uint8Array {
  return encodeSyrinxAudioEnvelope({
    type: "audio",
    contextId: options.contextId,
    sampleRateHz,
    sequence: options.sequence,
    encoding: "pcm_s16le",
    channels: 1,
    byteLength: audio.byteLength,
    durationMs: Math.round((audio.byteLength / 2 / sampleRateHz) * 1000),
  }, audio);
}
