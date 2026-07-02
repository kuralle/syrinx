// SPDX-License-Identifier: MIT
//
// R2-backed implementation of the transport EdgeRecorder. Taps inbound caller
// audio and outbound TTS audio and writes to an R2 bucket:
//   - user.wav / assistant.wav : the per-speaker stems, time-aligned by wall-clock
//                        (user chunks at their wall offset; assistant re-anchored to
//                        playout) with silence filling the gaps — the durable artifacts.
//   - conversation.wav : best-effort stereo mix (user = left, assistant = right),
//                        written only for short calls that stayed wholly in DO RAM;
//                        omitted (flagged in the manifest) once a stem streams out.
//   - manifest.json    : durations / byte lengths / truncation flags.
// Mirrors the Node `voice-recorder` conversation-track approach (wall-clock byte
// offsets + stereo interleave) but stays edge-safe (no node:fs).
//
// Memory: the DO has ~128 MB. Rather than buffer the whole call and gap-fill the full
// wall-clock length at finalize (which OOMs long/mostly-silent calls), each stem is
// gap-filled INCREMENTALLY and streamed to R2 via multipart upload: bytes accumulate
// into a bounded buffer and flush as 5 MiB parts, so retained memory stays ~O(part size)
// per stem regardless of call length. Short calls (< one part) never open a multipart and
// are written with a single put, exactly as before.

import type { EdgeRecorder } from "@kuralle-syrinx/server-websocket/edge";
import { interleaveStereoPcm16, pcm16ToWav } from "@kuralle-syrinx/recorder/wav";

export interface R2EdgeRecorderOptions {
  readonly bucket: R2Bucket;
  readonly sessionId: string;
  readonly startedAtMs: number;
  /** Object key prefix. Default "recordings". */
  readonly keyPrefix?: string;
  /**
   * Optional per-stream truncation cap on captured audio bytes. Past it, audio is
   * dropped and the stem is flagged `truncated`. Default: unlimited — memory is bounded
   * by streaming, not by retention, so any length records without OOM.
   */
  readonly maxBytesPerStream?: number;
  /** Injectable clock (test seam). Defaults to Date.now. */
  readonly now?: () => number;
}

// R2 requires every multipart part except the last to be at least 5 MiB. We flush at
// exactly that: bigger parts waste RAM, smaller ones are rejected.
const PART_SIZE_BYTES = 5 * 1024 * 1024;
// Emit long silence gaps in small slices so a multi-minute gap never allocates its full
// wall-clock length at once (that was the OOM).
const SILENCE_SLICE_BYTES = 64 * 1024;

/** A FIFO byte queue that hands back exact-length runs without holding the whole call. */
class PartBuffer {
  #chunks: Uint8Array[] = [];
  #size = 0;

  push(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    this.#chunks.push(bytes);
    this.#size += bytes.byteLength;
  }

  get size(): number {
    return this.#size;
  }

  /** Remove and return the first `n` bytes (caller guarantees n <= size). */
  take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const head = this.#chunks[0]!;
      const need = n - filled;
      if (head.byteLength <= need) {
        out.set(head, filled);
        filled += head.byteLength;
        this.#chunks.shift();
      } else {
        out.set(head.subarray(0, need), filled);
        this.#chunks[0] = head.subarray(need);
        filled += need;
      }
    }
    this.#size -= n;
    return out;
  }

  drain(): Uint8Array {
    return this.take(this.#size);
  }
}

interface Stem {
  readonly key: string;
  readonly buf: PartBuffer;
  /** Deferred part-1 payload (the first PART_SIZE bytes) once the stem goes multipart. */
  head: Uint8Array | null;
  multipart: boolean;
  uploadId: string | null;
  parts: R2UploadedPart[];
  partSeq: number; // next partNumber for streamed middle parts (part 1 reserved for the header)
  tail: Promise<void>; // serialises the async create/upload chain fired from sync callbacks
  cursorBytes: number; // end of the last placed chunk on the wall-clock timeline
  dataBytes: number; // actual audio bytes captured (for the cap)
  sampleRateHz: number;
  truncated: boolean;
}

export class R2EdgeRecorder implements EdgeRecorder {
  readonly #prefix: string;
  readonly #user: Stem;
  readonly #assistant: Stem;
  readonly #maxBytes: number | undefined;
  readonly #now: () => number;
  #finalized = false;

  constructor(private readonly opts: R2EdgeRecorderOptions) {
    this.#prefix = `${opts.keyPrefix ?? "recordings"}/${opts.sessionId}/${opts.startedAtMs}`;
    this.#user = this.#emptyStem(`${this.#prefix}/user.wav`);
    this.#assistant = this.#emptyStem(`${this.#prefix}/assistant.wav`);
    this.#maxBytes = opts.maxBytesPerStream;
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

    const rate = this.#user.sampleRateHz; // conversation timeline runs at the user (input) rate

    // Close each stem sequentially (never hold both full WAV copies at once). A stem that
    // never streamed hands back its full mono PCM so a best-effort stereo mix can be built.
    const userMono = await this.#closeStem(this.#user);
    const assistantMono = await this.#closeStem(this.#assistant);

    const conversation =
      userMono && assistantMono
        ? await this.#writeStereo(userMono, assistantMono, rate)
        : {
            path: `${this.#prefix}/conversation.wav`,
            sampleRateHz: rate,
            channels: 2 as const,
            encoding: "pcm_s16le" as const,
            byteLength: 0,
            durationMs: 0,
            omitted: true as const,
          };

    const manifest = {
      schemaVersion: 1 as const,
      sessionId: meta.sessionId,
      startedAtMs: this.opts.startedAtMs,
      closedAtMs: meta.closedAtMs,
      conversation,
      user: this.#describe(this.#user),
      assistant: this.#describe(this.#assistant),
    };

    await this.opts.bucket.put(`${this.#prefix}/manifest.json`, JSON.stringify(manifest, null, 2), {
      httpMetadata: { contentType: "application/json" },
    });
  }

  #emptyStem(key: string): Stem {
    return {
      key,
      buf: new PartBuffer(),
      head: null,
      multipart: false,
      uploadId: null,
      parts: [],
      partSeq: 2,
      tail: Promise.resolve(),
      cursorBytes: 0,
      dataBytes: 0,
      sampleRateHz: 16000,
      truncated: false,
    };
  }

  #append(stem: Stem, audio: Uint8Array, sampleRateHz: number): void {
    stem.sampleRateHz = sampleRateHz;
    if (this.#maxBytes !== undefined && stem.dataBytes + audio.byteLength > this.#maxBytes) {
      stem.truncated = true;
      return;
    }
    // Anchor each chunk at its wall-clock position so the two speakers line up on a shared
    // timeline; never overlap the previous chunk. Emit the intervening silence + the chunk
    // incrementally so the timeline is never materialised whole.
    const wallOffset = this.#wallOffsetBytes(sampleRateHz);
    const offsetBytes = Math.max(stem.cursorBytes, wallOffset);
    const gap = offsetBytes - stem.cursorBytes;
    if (gap > 0) this.#emitSilence(stem, gap);
    this.#emit(stem, audio.slice());
    stem.cursorBytes = offsetBytes + audio.byteLength;
    stem.dataBytes += audio.byteLength;
  }

  #emitSilence(stem: Stem, bytes: number): void {
    let remaining = bytes;
    while (remaining > 0) {
      const slice = Math.min(remaining, SILENCE_SLICE_BYTES);
      this.#emit(stem, new Uint8Array(slice)); // zero = PCM16 silence
      remaining -= slice;
    }
  }

  #emit(stem: Stem, bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    stem.buf.push(bytes);
    if (!stem.multipart && stem.buf.size >= PART_SIZE_BYTES) {
      // Commit to multipart: retain the first part's worth as the deferred part 1 (its WAV
      // header needs the final total length, known only at finalize), then stream the rest.
      stem.head = stem.buf.take(PART_SIZE_BYTES);
      stem.multipart = true;
      this.#enqueueCreate(stem);
    }
    if (stem.multipart) {
      while (stem.buf.size >= PART_SIZE_BYTES) {
        this.#enqueueUpload(stem, stem.partSeq++, stem.buf.take(PART_SIZE_BYTES));
      }
    }
  }

  #enqueueCreate(stem: Stem): void {
    stem.tail = stem.tail.then(async () => {
      const mpu = await this.opts.bucket.createMultipartUpload(stem.key, {
        httpMetadata: { contentType: "audio/wav" },
      });
      stem.uploadId = mpu.uploadId;
    });
  }

  #enqueueUpload(stem: Stem, partNumber: number, body: Uint8Array): void {
    stem.tail = stem.tail.then(async () => {
      const mpu = this.opts.bucket.resumeMultipartUpload(stem.key, stem.uploadId!);
      stem.parts.push(await mpu.uploadPart(partNumber, body));
    });
  }

  /** Flush a stem to R2. Returns its full mono PCM if it stayed in RAM, else null. */
  async #closeStem(stem: Stem): Promise<Uint8Array | null> {
    if (!stem.multipart) {
      const mono = stem.buf.drain();
      await this.opts.bucket.put(stem.key, pcm16ToWav(mono, stem.sampleRateHz, 1), {
        httpMetadata: { contentType: "audio/wav" },
      });
      return mono;
    }
    await stem.tail; // drain the queued create + middle-part uploads
    const mpu = this.opts.bucket.resumeMultipartUpload(stem.key, stem.uploadId!);
    // Part 1 = the WAV header (now that the total data length is known) + the retained head.
    const head = stem.head ?? new Uint8Array(0);
    const part1 = concat(wavHeader(stem.cursorBytes, stem.sampleRateHz, 1), head);
    stem.parts.push(await mpu.uploadPart(1, part1));
    const remainder = stem.buf.drain();
    if (remainder.byteLength > 0) stem.parts.push(await mpu.uploadPart(stem.partSeq++, remainder));
    stem.parts.sort((a, b) => a.partNumber - b.partNumber);
    await mpu.complete(stem.parts);
    return null;
  }

  async #writeStereo(userPcm: Uint8Array, assistantMono: Uint8Array, rate: number) {
    const assistantPcm =
      this.#assistant.sampleRateHz === rate
        ? assistantMono
        : resamplePcm16(assistantMono, this.#assistant.sampleRateHz, rate);
    const stereo = interleaveStereoPcm16(userPcm, assistantPcm);
    await this.opts.bucket.put(`${this.#prefix}/conversation.wav`, pcm16ToWav(stereo, rate, 2), {
      httpMetadata: { contentType: "audio/wav" },
    });
    return {
      path: `${this.#prefix}/conversation.wav`,
      sampleRateHz: rate,
      channels: 2 as const,
      encoding: "pcm_s16le" as const,
      byteLength: stereo.byteLength,
      durationMs: rate > 0 ? Math.round((stereo.byteLength / 4 / rate) * 1000) : 0,
      omitted: false as const,
    };
  }

  #wallOffsetBytes(sampleRateHz: number): number {
    const elapsedMs = Math.max(0, this.#now() - this.opts.startedAtMs);
    const bytes = Math.floor((elapsedMs * sampleRateHz * 2) / 1000);
    return bytes - (bytes % 2);
  }

  #describe(stem: Stem) {
    return {
      path: stem.key,
      sampleRateHz: stem.sampleRateHz,
      encoding: "pcm_s16le" as const,
      channels: 1 as const,
      byteLength: stem.cursorBytes,
      durationMs: stem.sampleRateHz > 0 ? Math.round((stem.cursorBytes / 2 / stem.sampleRateHz) * 1000) : 0,
      truncated: stem.truncated,
    };
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

/** Build the 44-byte canonical WAV (RIFF/PCM) header for a stream of `dataBytes` PCM16LE. */
function wavHeader(dataBytes: number, sampleRateHz: number, channels: number): Uint8Array {
  const blockAlign = channels * 2; // 16-bit samples
  const byteRate = sampleRateHz * blockAlign;
  const out = new Uint8Array(44);
  const view = new DataView(out.buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
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
  view.setUint32(40, dataBytes, true);
  return out;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
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
