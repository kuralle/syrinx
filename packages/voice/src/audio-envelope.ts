// SPDX-License-Identifier: MIT

import type { AudioFormat } from "./packets.js";

export const SYRINX_AUDIO_ENVELOPE_NAME = "syrinx.audio.v1" as const;
export const SYRINX_AUDIO_ENVELOPE_MAGIC = new Uint8Array([83, 89, 82, 88, 65, 49, 10]);

export interface SyrinxAudioEnvelopeHeader {
  readonly type: "audio";
  readonly contextId?: string;
  readonly sampleRateHz: number;
  readonly sequence?: number;
  readonly encoding?: "pcm_s16le" | "opus";
  readonly channels?: 1;
  readonly byteLength?: number;
  readonly durationMs?: number;
}

export interface SyrinxAudioEnvelope {
  readonly header: SyrinxAudioEnvelopeHeader;
  readonly audio: Uint8Array;
}

export function assertAudioFormat(format: AudioFormat): void {
  if (format.channels !== 1) throw new Error("audio must be mono");
  if (!Number.isInteger(format.sampleRateHz) || format.sampleRateHz <= 0) {
    throw new Error("sampleRateHz must be a positive integer");
  }
}

export function assertAudioPayload(format: AudioFormat, audio: Uint8Array): void {
  if (format.encoding === "opus") {
    if (audio.byteLength === 0) {
      throw new Error("opus payload must not be empty");
    }
    return;
  }
  if (format.encoding === "mulaw") {
    if (audio.byteLength === 0) {
      throw new Error("mulaw payload must not be empty");
    }
    return;
  }
  if (audio.byteLength % 2 !== 0) {
    throw new Error("PCM16 payload must contain an even number of bytes");
  }
}

export function encodeSyrinxAudioEnvelope(header: SyrinxAudioEnvelopeHeader, audio: Uint8Array): Uint8Array {
  validateSyrinxAudioEnvelope(header, audio);
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const output = new Uint8Array(SYRINX_AUDIO_ENVELOPE_MAGIC.byteLength + 4 + headerBytes.byteLength + audio.byteLength);
  output.set(SYRINX_AUDIO_ENVELOPE_MAGIC, 0);
  new DataView(output.buffer, output.byteOffset, output.byteLength)
    .setUint32(SYRINX_AUDIO_ENVELOPE_MAGIC.byteLength, headerBytes.byteLength, true);
  output.set(headerBytes, SYRINX_AUDIO_ENVELOPE_MAGIC.byteLength + 4);
  output.set(audio, SYRINX_AUDIO_ENVELOPE_MAGIC.byteLength + 4 + headerBytes.byteLength);
  return output;
}

export function decodeSyrinxAudioEnvelope(data: Uint8Array): SyrinxAudioEnvelope {
  if (!hasSyrinxAudioEnvelope(data)) {
    throw new Error("Syrinx binary audio envelope magic is missing");
  }

  const headerLengthOffset = SYRINX_AUDIO_ENVELOPE_MAGIC.byteLength;
  if (data.byteLength < headerLengthOffset + 4) {
    throw new Error("Syrinx binary audio envelope is truncated");
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const headerLength = view.getUint32(headerLengthOffset, true);
  const headerStart = headerLengthOffset + 4;
  const headerEnd = headerStart + headerLength;
  if (headerLength <= 0 || headerEnd > data.byteLength) {
    throw new Error("Syrinx binary audio envelope has an invalid header length");
  }

  const parsed = JSON.parse(new TextDecoder().decode(data.subarray(headerStart, headerEnd))) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Syrinx binary audio envelope header must be an object");
  }
  const header = parsed as SyrinxAudioEnvelopeHeader;
  const audio = data.subarray(headerEnd);
  validateSyrinxAudioEnvelope(header, audio);

  return { header, audio };
}

export function hasSyrinxAudioEnvelope(data: Uint8Array): boolean {
  if (data.byteLength < SYRINX_AUDIO_ENVELOPE_MAGIC.byteLength) return false;
  for (let i = 0; i < SYRINX_AUDIO_ENVELOPE_MAGIC.byteLength; i += 1) {
    if (data[i] !== SYRINX_AUDIO_ENVELOPE_MAGIC[i]) return false;
  }
  return true;
}

function validateSyrinxAudioEnvelope(header: SyrinxAudioEnvelopeHeader, audio: Uint8Array): void {
  if (header.type !== "audio") {
    throw new Error("Syrinx binary audio envelope type must be audio");
  }
  if (!isPositiveInteger(header.sampleRateHz)) {
    throw new Error("Syrinx binary audio envelope sampleRateHz must be a positive integer");
  }
  if (header.encoding && header.encoding !== "pcm_s16le" && header.encoding !== "opus") {
    throw new Error(`Unsupported Syrinx binary audio encoding: ${header.encoding}`);
  }
  if (header.sequence !== undefined && !isNonNegativeInteger(header.sequence)) {
    throw new Error("Syrinx binary audio envelope sequence must be a non-negative integer");
  }
  if (header.durationMs !== undefined && !isNonNegativeInteger(header.durationMs)) {
    throw new Error("Syrinx binary audio envelope durationMs must be a non-negative integer");
  }
  if (header.byteLength !== undefined && !isNonNegativeInteger(header.byteLength)) {
    throw new Error("Syrinx binary audio envelope byteLength must be a non-negative integer");
  }
  if (header.byteLength !== undefined && header.byteLength !== audio.byteLength) {
    throw new Error("Syrinx binary audio envelope byteLength does not match payload");
  }

  const format: AudioFormat = {
    encoding: header.encoding === "opus" ? "opus" : "pcm_s16le",
    sampleRateHz: header.sampleRateHz,
    channels: header.channels ?? 1,
  };
  assertAudioFormat(format);
  assertAudioPayload(format, audio);

  if (format.encoding !== "opus" && header.durationMs !== undefined) {
    const expectedDurationMs = Math.round((audio.byteLength / 2 / header.sampleRateHz) * 1000);
    if (Math.abs(header.durationMs - expectedDurationMs) > 1) {
      throw new Error("Syrinx binary audio envelope durationMs does not match payload and sampleRateHz");
    }
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
