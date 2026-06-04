// SPDX-License-Identifier: MIT
//
// R2-backed implementation of the transport EdgeRecorder. Taps inbound caller
// audio and outbound TTS audio and, on call end, writes to an R2 bucket:
//   - conversation.wav : the FULL conversation, one stereo file (user = left,
//                        assistant = right), time-aligned by wall-clock so the
//                        assistant sits after the user instead of stacked at 0.
//   - user.wav / assistant.wav : the per-speaker stems (useful for diarization).
//   - manifest.json    : durations / byte lengths / truncation flags.
// Mirrors the Node `voice-recorder` conversation-track approach (wall-clock byte
// offsets + stereo interleave) but stays edge-safe (no node:fs). Cloudflare's own
// withVoice persists transcripts to SQLite, not raw audio — this is the additive
// piece. Buffered (memory-capped) and flushed once on finalize, off the hot path.

import type { EdgeRecorder } from "@asyncdot/voice-server-websocket/edge";

export interface R2EdgeRecorderOptions {
  readonly bucket: R2Bucket;
  readonly sessionId: string;
  readonly startedAtMs: number;
  /** Object key prefix. Default "recordings". */
  readonly keyPrefix?: string;
  /** Per-stream memory cap; recording past it is dropped and flagged. Default 64 MiB. */
  readonly maxBytesPerStream?: number;
  /** Injectable clock (test seam). Defaults to Date.now. */
  readonly now?: () => number;
}

const DEFAULT_MAX_BYTES_PER_STREAM = 64 * 1024 * 1024;

interface AudioChunk {
  offsetBytes: number;
  data: Uint8Array;
}

interface StreamBuffer {
  chunks: AudioChunk[];
  cursorBytes: number; // end of the last placed chunk on the wall-clock timeline
  dataBytes: number; // actual audio bytes captured (for the cap)
  sampleRateHz: number;
  truncated: boolean;
}

function emptyStream(): StreamBuffer {
  return { chunks: [], cursorBytes: 0, dataBytes: 0, sampleRateHz: 16000, truncated: false };
}

export class R2EdgeRecorder implements EdgeRecorder {
  readonly #user = emptyStream();
  readonly #assistant = emptyStream();
  readonly #maxBytes: number;
  readonly #now: () => number;
  #finalized = false;

  constructor(private readonly opts: R2EdgeRecorderOptions) {
    this.#maxBytes = opts.maxBytesPerStream ?? DEFAULT_MAX_BYTES_PER_STREAM;
    this.#now = opts.now ?? Date.now;
  }

  onUserAudio(_contextId: string, audio: Uint8Array, sampleRateHz: number): void {
    this.#append(this.#user, audio, sampleRateHz);
  }

  onAssistantAudio(_contextId: string, audio: Uint8Array, sampleRateHz: number): void {
    this.#append(this.#assistant, audio, sampleRateHz);
  }

  async finalize(meta: { sessionId: string; closedAtMs: number }): Promise<void> {
    if (this.#finalized) return;
    this.#finalized = true;
    if (this.#user.dataBytes === 0 && this.#assistant.dataBytes === 0) return;

    const prefix = `${this.opts.keyPrefix ?? "recordings"}/${this.opts.sessionId}/${this.opts.startedAtMs}`;
    const rate = this.#user.sampleRateHz; // conversation timeline runs at the user (input) rate

    const userPcm = gapFill(this.#user);
    const assistantRaw = gapFill(this.#assistant);
    const assistantPcm =
      this.#assistant.sampleRateHz === rate
        ? assistantRaw
        : resamplePcm16(assistantRaw, this.#assistant.sampleRateHz, rate);
    const conversation = interleaveStereo(userPcm, assistantPcm);

    const manifest = {
      schemaVersion: 1 as const,
      sessionId: meta.sessionId,
      startedAtMs: this.opts.startedAtMs,
      closedAtMs: meta.closedAtMs,
      conversation: {
        path: `${prefix}/conversation.wav`,
        sampleRateHz: rate,
        channels: 2 as const,
        encoding: "pcm_s16le" as const,
        byteLength: conversation.byteLength,
        durationMs: rate > 0 ? Math.round((conversation.byteLength / 4 / rate) * 1000) : 0,
      },
      user: this.#describe(this.#user, `${prefix}/user.wav`),
      assistant: this.#describe(this.#assistant, `${prefix}/assistant.wav`),
    };

    await Promise.all([
      this.opts.bucket.put(`${prefix}/conversation.wav`, pcm16ToWav(conversation, rate, 2), {
        httpMetadata: { contentType: "audio/wav" },
      }),
      this.opts.bucket.put(`${prefix}/user.wav`, pcm16ToWav(userPcm, this.#user.sampleRateHz, 1), {
        httpMetadata: { contentType: "audio/wav" },
      }),
      this.opts.bucket.put(`${prefix}/assistant.wav`, pcm16ToWav(assistantRaw, this.#assistant.sampleRateHz, 1), {
        httpMetadata: { contentType: "audio/wav" },
      }),
      this.opts.bucket.put(`${prefix}/manifest.json`, JSON.stringify(manifest, null, 2), {
        httpMetadata: { contentType: "application/json" },
      }),
    ]);
  }

  #append(buf: StreamBuffer, audio: Uint8Array, sampleRateHz: number): void {
    buf.sampleRateHz = sampleRateHz;
    if (buf.dataBytes + audio.byteLength > this.#maxBytes) {
      buf.truncated = true;
      return;
    }
    // Anchor each chunk at its wall-clock position so the two speakers line up on a
    // shared timeline; never overlap the previous chunk in the same stream.
    const wallOffset = this.#wallOffsetBytes(sampleRateHz);
    const offsetBytes = Math.max(buf.cursorBytes, wallOffset);
    buf.chunks.push({ offsetBytes, data: audio.slice() });
    buf.cursorBytes = offsetBytes + audio.byteLength;
    buf.dataBytes += audio.byteLength;
  }

  #wallOffsetBytes(sampleRateHz: number): number {
    const elapsedMs = Math.max(0, this.#now() - this.opts.startedAtMs);
    const bytes = Math.floor((elapsedMs * sampleRateHz * 2) / 1000);
    return bytes - (bytes % 2);
  }

  #describe(buf: StreamBuffer, path: string) {
    return {
      path,
      sampleRateHz: buf.sampleRateHz,
      encoding: "pcm_s16le" as const,
      channels: 1 as const,
      byteLength: buf.cursorBytes,
      durationMs: buf.sampleRateHz > 0 ? Math.round((buf.cursorBytes / 2 / buf.sampleRateHz) * 1000) : 0,
      truncated: buf.truncated,
    };
  }
}

/** Lay chunks onto a silence-filled mono timeline at their wall-clock offsets. */
function gapFill(buf: StreamBuffer): Uint8Array {
  const out = new Uint8Array(buf.cursorBytes); // zero = PCM16 silence
  for (const chunk of buf.chunks) out.set(chunk.data, chunk.offsetBytes);
  return out;
}

/** Interleave two mono PCM16 streams into stereo (left, right); pad the short one. */
function interleaveStereo(left: Uint8Array, right: Uint8Array): Uint8Array {
  const leftSamples = left.byteLength >> 1;
  const rightSamples = right.byteLength >> 1;
  const frames = Math.max(leftSamples, rightSamples);
  const out = new Uint8Array(frames * 4);
  const lv = new DataView(left.buffer, left.byteOffset, left.byteLength);
  const rv = new DataView(right.buffer, right.byteOffset, right.byteLength);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < frames; i += 1) {
    ov.setInt16(i * 4, i < leftSamples ? lv.getInt16(i * 2, true) : 0, true);
    ov.setInt16(i * 4 + 2, i < rightSamples ? rv.getInt16(i * 2, true) : 0, true);
  }
  return out;
}

function resamplePcm16(pcm: Uint8Array, fromHz: number, toHz: number): Uint8Array {
  if (fromHz === toHz || pcm.byteLength === 0) return pcm;
  const src = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const inSamples = pcm.byteLength >> 1;
  const outSamples = Math.max(1, Math.round((inSamples * toHz) / fromHz));
  const out = new Uint8Array(outSamples * 2);
  const ov = new DataView(out.buffer);
  const ratio = (inSamples - 1) / Math.max(1, outSamples - 1);
  for (let i = 0; i < outSamples; i += 1) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(inSamples - 1, i0 + 1);
    const frac = x - i0;
    const s = src.getInt16(i0 * 2, true) * (1 - frac) + src.getInt16(i1 * 2, true) * frac;
    ov.setInt16(i * 2, Math.round(s), true);
  }
  return out;
}

/** Wrap raw PCM16 little-endian bytes in a canonical 44-byte WAV header. */
function pcm16ToWav(pcm: Uint8Array, sampleRateHz: number, channels: number): Uint8Array {
  const blockAlign = channels * 2; // 16-bit
  const byteRate = sampleRateHz * blockAlign;
  const out = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(out.buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}
