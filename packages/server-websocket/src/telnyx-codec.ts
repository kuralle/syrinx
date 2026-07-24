// SPDX-License-Identifier: MIT
//
// Workers-safe Telnyx codec helpers (TypedArray only — no Node Buffer / process /
// node: imports). Shared by the Node host (`telnyx.ts`) and the Workers edge
// runner (`edge-telnyx.ts`). Live trunk negotiation remains carrier-gated.

import {
  bigEndianPcm16BytesToSamples,
  createG722DecoderState,
  createG722EncoderState,
  decodeALawToPcm16,
  decodeG722,
  decodeMuLawToPcm16,
  encodeG722,
  encodePcm16ToALaw,
  encodePcm16ToMuLaw,
  pcm16SamplesToBigEndianBytes,
  type G722DecoderState,
  type G722EncoderState,
} from "@kuralle-syrinx/core/audio";

/** Telnyx stream codecs. PCMA/G722 unit-tested; live trunk negotiation unverified. */
export type TelnyxCodec = "PCMU" | "L16" | "PCMA" | "G722";

export interface TelnyxStartMediaFormat {
  readonly encoding?: string;
  readonly sample_rate?: number | string;
  readonly channels?: number | string;
}

export interface TelnyxStartPayload {
  readonly stream_id?: string;
  readonly call_control_id?: string;
  readonly call_session_id?: string;
  readonly media_format?: TelnyxStartMediaFormat;
}

/** Stateful G.722 pair for a stream. Other codecs leave both null. */
export interface TelnyxG722State {
  decoder: G722DecoderState | null;
  encoder: G722EncoderState | null;
}

export function wireSampleRateForCodec(codec: TelnyxCodec): number {
  return codec === "L16" || codec === "G722" ? 16_000 : 8_000;
}

/** Alias kept for callers that used the Node-side name. */
export const outboundSampleRateForCodec = wireSampleRateForCodec;

export function createTelnyxG722State(codec: TelnyxCodec): TelnyxG722State {
  if (codec !== "G722") return { decoder: null, encoder: null };
  return {
    decoder: createG722DecoderState(),
    encoder: createG722EncoderState(),
  };
}

export function validateTelnyxStart(
  start: TelnyxStartPayload,
): { readonly codec: TelnyxCodec; readonly sampleRateHz: number } {
  const format = start.media_format;
  if (!format) throw new Error("Telnyx start event is missing media_format");
  const encoding = format.encoding?.trim().toUpperCase();
  if (encoding !== "PCMU" && encoding !== "L16" && encoding !== "PCMA" && encoding !== "G722") {
    throw new Error(`Unsupported Telnyx media encoding: ${format.encoding ?? "unknown"}`);
  }
  const sampleRateHz = numberFromString(format.sample_rate);
  if (sampleRateHz === null) throw new Error(`Unsupported Telnyx sample rate: ${String(format.sample_rate)}`);
  if ((encoding === "PCMU" || encoding === "PCMA") && sampleRateHz !== 8000) {
    throw new Error(`Unsupported Telnyx ${encoding} sample rate: ${String(format.sample_rate)}`);
  }
  if ((encoding === "L16" || encoding === "G722") && sampleRateHz !== 16000) {
    throw new Error(`Unsupported Telnyx ${encoding} sample rate: ${String(format.sample_rate)}`);
  }
  const channels = numberFromString(format.channels);
  if (channels !== 1) throw new Error(`Unsupported Telnyx channel count: ${String(format.channels)}`);
  return { codec: encoding as TelnyxCodec, sampleRateHz };
}

/**
 * Decode a Telnyx media payload (RTP bytes, already base64-decoded) to PCM16 at
 * the wire sample rate. G.722 keeps 16 kHz — do not downsample before STT.
 */
export function decodeTelnyxInboundPayload(
  input: Uint8Array,
  codec: TelnyxCodec,
  g722: TelnyxG722State,
): Int16Array {
  switch (codec) {
    case "PCMU":
      return decodeMuLawToPcm16(input);
    case "PCMA":
      return decodeALawToPcm16(input);
    case "G722": {
      if (!g722.decoder) g722.decoder = createG722DecoderState();
      return decodeG722(g722.decoder, input);
    }
    case "L16":
      return bigEndianPcm16BytesToSamples(input);
  }
}

/** Encode PCM16 samples already at the wire sample rate into a Telnyx media payload. */
export function encodeTelnyxOutboundPayload(
  samples: Int16Array,
  codec: TelnyxCodec,
  g722: TelnyxG722State,
): Uint8Array {
  switch (codec) {
    case "PCMU":
      return encodePcm16ToMuLaw(samples);
    case "PCMA":
      return encodePcm16ToALaw(samples);
    case "G722": {
      if (!g722.encoder) g722.encoder = createG722EncoderState();
      return encodeG722(g722.encoder, samples);
    }
    case "L16":
      return pcm16SamplesToBigEndianBytes(samples);
  }
}

/**
 * Split an encoded payload into fixed-duration wire frames (Node paced playout).
 * G.722: 1 byte per 2 samples @ 16 kHz; L16: 2 bytes/sample; PCMU/PCMA: 1 byte/sample.
 */
export function splitTelnyxEncodedFrames(
  encoded: Uint8Array,
  codec: TelnyxCodec,
  wireSampleRateHz: number,
  frameDurationMs: number,
): Uint8Array[] {
  const samplesPerFrame = Math.max(1, Math.round((wireSampleRateHz * frameDurationMs) / 1000));
  const frameBytes =
    codec === "G722"
      ? Math.max(1, samplesPerFrame >> 1)
      : samplesPerFrame * (codec === "L16" ? 2 : 1);
  const frames: Uint8Array[] = [];
  for (let offset = 0; offset < encoded.byteLength; offset += frameBytes) {
    frames.push(encoded.subarray(offset, Math.min(encoded.byteLength, offset + frameBytes)));
  }
  return frames;
}

export function defaultTelnyxContextId(start: TelnyxStartPayload): string {
  const callControlId = start.call_control_id?.trim();
  if (callControlId) return `telnyx-${callControlId}`;
  const callSessionId = start.call_session_id?.trim();
  if (callSessionId) return `telnyx-${callSessionId}`;
  const streamId = start.stream_id?.trim();
  if (streamId) return `telnyx-${streamId}`;
  return `telnyx-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function numberFromString(value: number | string | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}
