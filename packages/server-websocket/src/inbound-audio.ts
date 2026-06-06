// SPDX-License-Identifier: MIT

import {
  SYRINX_AUDIO_ENVELOPE_NAME,
  decodeSyrinxAudioEnvelope,
  hasSyrinxAudioEnvelope,
} from "@kuralle-syrinx/core";
import {
  pcm16BytesToSamples,
  pcm16SamplesToBytes,
  resamplePcm16Streaming,
  type StreamingPcm16Resampler,
} from "@kuralle-syrinx/core/audio";

export type OpusIngressDecoder = (wire: Uint8Array, sampleRateHz: number) => Uint8Array;

export interface DecodedInboundBinaryAudio {
  readonly contextId?: string;
  readonly sampleRateHz: number;
  readonly sequence?: number;
  readonly audio: Uint8Array;
}

export function socketDataToBytes(data: string | Uint8Array): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data);
  return data;
}

export function decodeInboundBinaryAudio(
  data: Uint8Array,
  defaultSampleRateHz: number,
  rawBinaryInput: boolean,
  engineInputSampleRateHz: number,
  streamingResamplers: Map<string, StreamingPcm16Resampler>,
  decodeOpusIngress: OpusIngressDecoder | null,
): DecodedInboundBinaryAudio {
  if (!hasSyrinxAudioEnvelope(data)) {
    if (!rawBinaryInput) {
      throw new Error(`Raw binary websocket audio is disabled; use ${SYRINX_AUDIO_ENVELOPE_NAME} or JSON audio frames`);
    }
    return { sampleRateHz: defaultSampleRateHz, audio: data };
  }
  const { header, audio } = decodeSyrinxAudioEnvelope(data);
  const sampleRateHz = requirePositiveIntegerFromHeader(header.sampleRateHz) ?? defaultSampleRateHz;
  const wireAudio = header.encoding === "opus"
    ? decodeOpusIngressMessage(audio, sampleRateHz, decodeOpusIngress, engineInputSampleRateHz, streamingResamplers)
    : audio;
  return {
    contextId: typeof header.contextId === "string" && header.contextId.length > 0 ? header.contextId : undefined,
    sampleRateHz,
    sequence: header.sequence,
    audio: wireAudio,
  };
}

function decodeOpusIngressMessage(
  wire: Uint8Array,
  sampleRateHz: number,
  decodeOpusIngress: OpusIngressDecoder | null,
  engineInputSampleRateHz: number,
  streamingResamplers: Map<string, StreamingPcm16Resampler>,
): Uint8Array {
  if (!decodeOpusIngress) throw new Error("Browser websocket opus ingress is not initialized");
  const pcm = decodeOpusIngress(wire, sampleRateHz);
  if (sampleRateHz === engineInputSampleRateHz) return pcm;
  const samples = pcm16BytesToSamples(pcm);
  return pcm16SamplesToBytes(
    resamplePcm16Streaming(streamingResamplers, samples, sampleRateHz, engineInputSampleRateHz),
  );
}

export function rememberContextSampleRate(
  contextSampleRates: Map<string, number>,
  contextId: string,
  sampleRateHz: number,
): void {
  const existing = contextSampleRates.get(contextId);
  if (existing !== undefined && existing !== sampleRateHz) {
    throw new Error(`Websocket audio sampleRateHz changed within context ${contextId}: ${existing} -> ${sampleRateHz}`);
  }
  contextSampleRates.set(contextId, sampleRateHz);
}

export function resampleAudioBytes(
  audio: Uint8Array,
  sourceSampleRateHz: number,
  targetSampleRateHz: number,
  streamingResamplers: Map<string, StreamingPcm16Resampler>,
): Uint8Array {
  if (audio.byteLength % 2 !== 0) {
    throw new Error("PCM16 audio payload must contain an even number of bytes");
  }
  if (sourceSampleRateHz === targetSampleRateHz) return audio;
  const samples = pcm16BytesToSamples(audio);
  const resampled = resamplePcm16Streaming(streamingResamplers, samples, sourceSampleRateHz, targetSampleRateHz);
  return pcm16SamplesToBytes(resampled);
}

function requirePositiveIntegerFromHeader(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return null;
  return value;
}
