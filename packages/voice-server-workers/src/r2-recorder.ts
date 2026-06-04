// SPDX-License-Identifier: MIT
//
// R2-backed implementation of the transport EdgeRecorder. Taps inbound caller
// audio and outbound TTS audio, buffers PCM16 (memory-bounded), and on call end
// writes user.wav + assistant.wav + manifest.json to an R2 bucket. Cloudflare's
// own withVoice persists transcripts to SQLite but not raw audio — this is the
// additive piece for full call recordings, kept off DO SQLite (wrong store for
// multi-MB audio) and off the hot path (flush once on finalize).

import type { EdgeRecorder } from "@asyncdot/voice-server-websocket/edge";

export interface R2EdgeRecorderOptions {
  readonly bucket: R2Bucket;
  readonly sessionId: string;
  readonly startedAtMs: number;
  /** Object key prefix. Default "recordings". */
  readonly keyPrefix?: string;
  /** Per-stream memory cap; recording past it is dropped and flagged. Default 64 MiB. */
  readonly maxBytesPerStream?: number;
}

const DEFAULT_MAX_BYTES_PER_STREAM = 64 * 1024 * 1024;

interface StreamBuffer {
  chunks: Uint8Array[];
  bytes: number;
  sampleRateHz: number;
  truncated: boolean;
}

export class R2EdgeRecorder implements EdgeRecorder {
  readonly #user: StreamBuffer = { chunks: [], bytes: 0, sampleRateHz: 16000, truncated: false };
  readonly #assistant: StreamBuffer = { chunks: [], bytes: 0, sampleRateHz: 16000, truncated: false };
  readonly #maxBytes: number;
  #finalized = false;

  constructor(private readonly opts: R2EdgeRecorderOptions) {
    this.#maxBytes = opts.maxBytesPerStream ?? DEFAULT_MAX_BYTES_PER_STREAM;
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
    if (this.#user.bytes === 0 && this.#assistant.bytes === 0) return;

    const prefix = `${this.opts.keyPrefix ?? "recordings"}/${this.opts.sessionId}/${this.opts.startedAtMs}`;
    const userWav = pcm16ToWav(concat(this.#user.chunks, this.#user.bytes), this.#user.sampleRateHz);
    const assistantWav = pcm16ToWav(concat(this.#assistant.chunks, this.#assistant.bytes), this.#assistant.sampleRateHz);
    const manifest = {
      schemaVersion: 1 as const,
      sessionId: meta.sessionId,
      startedAtMs: this.opts.startedAtMs,
      closedAtMs: meta.closedAtMs,
      user: this.#describe(this.#user, `${prefix}/user.wav`),
      assistant: this.#describe(this.#assistant, `${prefix}/assistant.wav`),
    };

    await Promise.all([
      this.opts.bucket.put(`${prefix}/user.wav`, userWav, { httpMetadata: { contentType: "audio/wav" } }),
      this.opts.bucket.put(`${prefix}/assistant.wav`, assistantWav, { httpMetadata: { contentType: "audio/wav" } }),
      this.opts.bucket.put(`${prefix}/manifest.json`, JSON.stringify(manifest, null, 2), {
        httpMetadata: { contentType: "application/json" },
      }),
    ]);
  }

  #append(buf: StreamBuffer, audio: Uint8Array, sampleRateHz: number): void {
    buf.sampleRateHz = sampleRateHz;
    if (buf.bytes + audio.byteLength > this.#maxBytes) {
      buf.truncated = true;
      return;
    }
    buf.chunks.push(audio.slice());
    buf.bytes += audio.byteLength;
  }

  #describe(buf: StreamBuffer, path: string) {
    return {
      path,
      sampleRateHz: buf.sampleRateHz,
      encoding: "pcm_s16le" as const,
      channels: 1 as const,
      byteLength: buf.bytes,
      durationMs: buf.sampleRateHz > 0 ? Math.round((buf.bytes / 2 / buf.sampleRateHz) * 1000) : 0,
      truncated: buf.truncated,
    };
  }
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Wrap raw PCM16 mono little-endian bytes in a canonical 44-byte WAV header. */
function pcm16ToWav(pcm: Uint8Array, sampleRateHz: number): Uint8Array {
  const blockAlign = 2; // mono * 16-bit
  const byteRate = sampleRateHz * blockAlign;
  const out = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(out.buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audioFormat = PCM
  view.setUint16(22, 1, true); // channels
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bitsPerSample
  writeAscii(view, 36, "data");
  view.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}
