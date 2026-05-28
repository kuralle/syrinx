// SPDX-License-Identifier: MIT

import {
  decodeSyrinxAudioEnvelope,
  encodeSyrinxAudioEnvelope,
  hasSyrinxAudioEnvelope,
  type SyrinxAudioEnvelopeHeader,
} from "@asyncdot/voice";

export interface ResampleFloat32Options {
  readonly fromSampleRateHz: number;
  readonly toSampleRateHz: number;
}

export interface EncodeBrowserAudioOptions extends ResampleFloat32Options {
  readonly contextId?: string;
  readonly sequence?: number;
}

export interface SyrinxAudioJsonFrame {
  readonly type: "audio";
  readonly audio: string;
  readonly sampleRateHz: number;
  readonly contextId?: string;
}

export interface BrowserAssistantAudio {
  readonly data: ArrayBuffer;
  readonly metadata?: SyrinxAudioEnvelopeHeader;
}

export function resampleFloat32Linear(input: Float32Array, options: ResampleFloat32Options): Float32Array {
  const fromRate = readPositiveSampleRate(options.fromSampleRateHz, "fromSampleRateHz");
  const toRate = readPositiveSampleRate(options.toSampleRateHz, "toSampleRateHz");
  if (fromRate === toRate) return input;

  const outLength = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const output = new Float32Array(outLength);
  const ratio = fromRate / toRate;

  for (let i = 0; i < outLength; i += 1) {
    const src = i * ratio;
    const lo = Math.floor(src);
    const hi = Math.min(input.length - 1, lo + 1);
    const frac = src - lo;
    output[i] = input[lo]! * (1 - frac) + input[hi]! * frac;
  }

  return output;
}

export function float32ToPcm16(samples: Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    pcm[i] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
  }
  return pcm;
}

export function encodeBrowserAudioFrame(input: Float32Array, options: EncodeBrowserAudioOptions): SyrinxAudioJsonFrame {
  const targetRate = readPositiveSampleRate(options.toSampleRateHz, "toSampleRateHz");
  const resampled = resampleFloat32Linear(input, options);
  const pcm = float32ToPcm16(resampled);
  return {
    type: "audio",
    contextId: options.contextId,
    sampleRateHz: targetRate,
    audio: bytesToBase64(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)),
  };
}

export function encodeBrowserAudioEnvelopeFrame(input: Float32Array, options: EncodeBrowserAudioOptions): Uint8Array {
  const targetRate = readPositiveSampleRate(options.toSampleRateHz, "toSampleRateHz");
  const resampled = resampleFloat32Linear(input, options);
  const pcm = float32ToPcm16(resampled);
  const audio = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  return encodeSyrinxAudioEnvelope({
    type: "audio",
    contextId: options.contextId,
    sampleRateHz: targetRate,
    sequence: options.sequence,
    encoding: "pcm_s16le",
    channels: 1,
    byteLength: audio.byteLength,
    durationMs: Math.round((pcm.length / targetRate) * 1000),
  }, audio);
}

export function pcm16FrameSampleCount(sampleRateHz: number, frameDurationMs = 20): number {
  const sampleRate = readPositiveSampleRate(sampleRateHz, "sampleRateHz");
  if (!Number.isFinite(frameDurationMs) || frameDurationMs <= 0) {
    throw new Error("frameDurationMs must be a positive number");
  }
  return Math.max(1, Math.round(sampleRate * (frameDurationMs / 1000)));
}

export function decodeBrowserAssistantAudio(input: ArrayBuffer | ArrayBufferView): BrowserAssistantAudio {
  const bytes = ArrayBuffer.isView(input)
    ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    : new Uint8Array(input);
  if (!hasSyrinxAudioEnvelope(bytes)) {
    return { data: copyArrayBuffer(bytes) };
  }
  const envelope = decodeSyrinxAudioEnvelope(bytes);
  return {
    data: copyArrayBuffer(envelope.audio),
    metadata: envelope.header,
  };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function readPositiveSampleRate(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive sample rate`);
  return value;
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
