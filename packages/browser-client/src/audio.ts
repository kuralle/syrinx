// SPDX-License-Identifier: MIT

import {
  decodeSyrinxAudioEnvelope,
  encodeSyrinxAudioEnvelope,
  hasSyrinxAudioEnvelope,
  type SyrinxAudioEnvelopeHeader,
} from "@kuralle-syrinx/core";
import { pcm16SamplesToBytes } from "@kuralle-syrinx/core/audio";
import type { BrowserOpusCodec } from "./browser-opus.js";

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
  readonly sequence?: number;
}

export interface BrowserAssistantAudio {
  readonly data: ArrayBuffer;
  readonly metadata?: SyrinxAudioEnvelopeHeader;
}

export interface AudioJitterBufferOptions {
  readonly targetBufferMs?: number;
  readonly sampleRateHz: number;
}

interface ScheduledAudioFrame {
  readonly buffer: AudioBuffer;
  readonly scheduledTime: number;
  readonly contextId?: string;
  source: AudioBufferSourceNode | null;
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
    sequence: options.sequence,
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

export function decodeBrowserAssistantAudio(
  input: ArrayBuffer | ArrayBufferView,
  opusCodec: BrowserOpusCodec | null = null,
): BrowserAssistantAudio {
  const bytes = ArrayBuffer.isView(input)
    ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    : new Uint8Array(input);
  if (!hasSyrinxAudioEnvelope(bytes)) {
    return { data: copyArrayBuffer(bytes) };
  }
  const envelope = decodeSyrinxAudioEnvelope(bytes);
  if (envelope.header.encoding === "opus") {
    if (!opusCodec) {
      return { data: new ArrayBuffer(0), metadata: envelope.header };
    }
    const wireRate = envelope.header.sampleRateHz;
    const decoded = opusCodec.decodeOpusFrame(envelope.audio);
    const pcm = pcm16SamplesToBytes(decoded);
    return {
      data: copyArrayBuffer(pcm),
      metadata: {
        ...envelope.header,
        encoding: "pcm_s16le",
        sampleRateHz: wireRate,
        byteLength: pcm.byteLength,
      },
    };
  }
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

export class AudioJitterBuffer {
  private readonly context: AudioContext;
  private readonly scheduledFrames = new Set<ScheduledAudioFrame>();
  private nextScheduledTime = 0;
  private readonly targetBufferMs: number;
  private readonly sampleRateHz: number;
  private readonly contextIds = new Set<string>();

  constructor(context: AudioContext, options: AudioJitterBufferOptions) {
    this.context = context;
    this.sampleRateHz = options.sampleRateHz;
    this.targetBufferMs = options.targetBufferMs ?? 100;
  }

  enqueue(pcm16Data: ArrayBuffer, contextId?: string): void {
    try {
      const pcm16Array = new Int16Array(pcm16Data);
      
      // Skip empty or invalid audio data
      if (pcm16Array.length === 0) {
        return;
      }
      
      const float32Array = new Float32Array(pcm16Array.length);
      
      // Convert PCM16 to Float32
      for (let i = 0; i < pcm16Array.length; i++) {
        float32Array[i] = pcm16Array[i]! / (pcm16Array[i]! < 0 ? 32768 : 32767);
      }

      const audioBuffer = this.context.createBuffer(1, float32Array.length, this.sampleRateHz);
      audioBuffer.copyToChannel(float32Array, 0);

      const now = this.context.currentTime;
      
      // If this is the first frame or we've fallen behind, establish baseline
      if (this.nextScheduledTime === 0 || this.nextScheduledTime < now) {
        this.nextScheduledTime = now + (this.targetBufferMs / 1000);
      }

      const frame: ScheduledAudioFrame = {
        buffer: audioBuffer,
        scheduledTime: this.nextScheduledTime,
        contextId,
        source: null,
      };

      this.scheduledFrames.add(frame);
      if (contextId) {
        this.contextIds.add(contextId);
      }

      // Schedule the audio
      const source = this.context.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.context.destination);
      
      frame.source = source;
      source.start(frame.scheduledTime);
      
      // Clean up when done
      source.onended = () => {
        this.scheduledFrames.delete(frame);
        frame.source = null;
      };

      this.nextScheduledTime += audioBuffer.duration;
    } catch (error) {
      console.warn("AudioJitterBuffer: Failed to enqueue audio frame:", error);
    }
  }

  clear(contextId?: string): void {
    if (contextId) {
      for (const frame of this.scheduledFrames) {
        if (frame.contextId === contextId) {
          if (frame.source) {
            try {
              frame.source.stop();
            } catch {
              // Ignore if already stopped
            }
          }
          this.scheduledFrames.delete(frame);
        }
      }
      this.contextIds.delete(contextId);
      this.recomputeNextScheduledTime();
    } else {
      // Clear all frames
      for (const frame of this.scheduledFrames) {
        if (frame.source) {
          try {
            frame.source.stop();
          } catch {
            // Ignore if already stopped
          }
        }
      }
      this.scheduledFrames.clear();
      this.contextIds.clear();
      this.nextScheduledTime = 0;
    }
  }

  get bufferedDurationMs(): number {
    if (this.scheduledFrames.size === 0) return 0;
    const now = this.context.currentTime;
    return Math.max(0, (this.nextScheduledTime - now) * 1000);
  }

  get activeContextIds(): readonly string[] {
    return [...this.contextIds];
  }

  private recomputeNextScheduledTime(): void {
    if (this.scheduledFrames.size === 0) {
      this.nextScheduledTime = 0;
      return;
    }
    let maxEnd = 0;
    for (const frame of this.scheduledFrames) {
      const end = frame.scheduledTime + frame.buffer.duration;
      if (end > maxEnd) maxEnd = end;
    }
    this.nextScheduledTime = maxEnd;
  }
}
