// SPDX-License-Identifier: MIT
//
// TurnAudioRecorder — keeps the microphone PCM you already streamed, sliced per turn,
// so a turn can be saved as a fixture. Without this the studio sends audio to the
// server and keeps none of it, and the "capture a fixture" loop cannot close.
//
// Dependency-free and DOM-free, exported from the `/turn-recorder` subpath: it takes
// Int16 frames and returns WAV bytes, so the same code runs in a browser, in Node, and
// in CI. It holds no socket and no AudioContext — you push it the frames you were
// sending anyway, and the server's own messages drive the turn boundaries.

import type { SyrinxStudioMessage } from "./index.js";

export interface TurnAudioRecorderOptions {
  /** Turns to retain audio for. Older blobs are dropped; the TurnRecord itself is not ours to evict. */
  readonly maxTurns?: number;
  /**
   * Audio kept from *before* `speech_started`, in ms.
   *
   * Load-bearing, not a nicety: VAD announces speech after onset, so a recorder that
   * starts buffering on `speech_started` clips the first phoneme. A fixture missing its
   * onset transcribes differently from the live turn it was captured from, which makes
   * it worse than no fixture — it looks like a real regression.
   */
  readonly preRollMs?: number;
  /** Hard ceiling per turn. A stuck endpointer must not grow a buffer without bound. */
  readonly maxTurnMs?: number;
}

export const DEFAULT_RECORDER_OPTIONS: Required<TurnAudioRecorderOptions> = {
  maxTurns: 10,
  preRollMs: 300,
  maxTurnMs: 60_000,
};

export interface RecordedTurnAudio {
  readonly turnId: string;
  readonly sampleRateHz: number;
  readonly durationMs: number;
  readonly byteLength: number;
  /** True when the turn hit `maxTurnMs` and the tail was dropped. Surfaced, never silent. */
  readonly truncated: boolean;
}

const DEFAULT_SAMPLE_RATE_HZ = 16_000;

/** Minimal RIFF/WAVE header + samples. Mono PCM16 — the format every STT accepts. */
export function encodeWav(samples: Int16Array, sampleRateHz: number): Uint8Array {
  if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0) {
    throw new Error(`encodeWav: invalid sampleRateHz ${String(sampleRateHz)}`);
  }
  const dataBytes = samples.length * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) out[offset + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, sampleRateHz * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  // Copy through a DataView so the result is little-endian on every host, rather than
  // inheriting the platform's byte order via Int16Array.set.
  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(44 + i * 2, samples[i] ?? 0, true);
  }
  return out;
}

interface OpenSegment {
  samples: Int16Array[];
  length: number;
  truncated: boolean;
}

export class TurnAudioRecorder {
  private readonly options: Required<TurnAudioRecorderOptions>;
  private sampleRateHz = DEFAULT_SAMPLE_RATE_HZ;
  /** Rolling pre-roll, trimmed to preRollMs on every push. */
  private preRoll: Int16Array[] = [];
  private preRollLength = 0;
  private open: OpenSegment | undefined;
  /** Sealed but not yet attributed to a turnId — turnId arrives with a later message. */
  private pending: { samples: Int16Array; truncated: boolean } | undefined;
  private readonly turns = new Map<string, { samples: Int16Array; truncated: boolean }>();

  constructor(options: TurnAudioRecorderOptions = {}) {
    this.options = { ...DEFAULT_RECORDER_OPTIONS, ...options };
  }

  /** Push the uplink frame you are already sending. Cheap: retains the reference, copies on seal. */
  pushFrame(frame: Int16Array): void {
    if (frame.length === 0) return;
    if (this.open) {
      const cap = Math.floor((this.options.maxTurnMs / 1000) * this.sampleRateHz);
      if (this.open.length >= cap) {
        this.open.truncated = true;
        return;
      }
      this.open.samples.push(frame);
      this.open.length += frame.length;
      return;
    }
    this.preRoll.push(frame);
    this.preRollLength += frame.length;
    const keep = Math.floor((this.options.preRollMs / 1000) * this.sampleRateHz);
    while (this.preRollLength - (this.preRoll[0]?.length ?? 0) >= keep && this.preRoll.length > 1) {
      this.preRollLength -= this.preRoll.shift()?.length ?? 0;
    }
  }

  /** Feed the same messages you feed the SessionRecord. Turn boundaries come from the server. */
  onMessage(message: SyrinxStudioMessage | { readonly type: string; readonly [k: string]: unknown }): void {
    const type = message.type;
    if (type === "ready") {
      const rate = (message as { audio?: { inputSampleRateHz?: unknown } }).audio?.inputSampleRateHz;
      if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) this.sampleRateHz = rate;
      return;
    }
    const turnId = typeof (message as { turnId?: unknown }).turnId === "string"
      ? (message as { turnId: string }).turnId
      : undefined;

    if (type === "speech_started") {
      // Start from the pre-roll so the onset is present.
      this.open = { samples: [...this.preRoll], length: this.preRollLength, truncated: false };
      this.preRoll = [];
      this.preRollLength = 0;
      if (turnId !== undefined) this.attributeOnSeal = turnId;
      return;
    }

    if (type === "speech_ended" || type === "stt_output" || type === "turn_complete") {
      this.seal(turnId);
      return;
    }
  }

  private attributeOnSeal: string | undefined;

  private seal(turnId: string | undefined): void {
    if (this.open) {
      const merged = new Int16Array(this.open.length);
      let offset = 0;
      for (const chunk of this.open.samples) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      this.pending = { samples: merged, truncated: this.open.truncated };
      this.open = undefined;
    }
    if (!this.pending) return;
    const id = turnId ?? this.attributeOnSeal;
    if (id === undefined) return; // wait for a message that names the turn
    this.attributeOnSeal = undefined;
    this.turns.set(id, this.pending);
    this.pending = undefined;
    // Bounded by construction: audio blobs, not the records, are the memory risk.
    while (this.turns.size > this.options.maxTurns) {
      const oldest = this.turns.keys().next().value;
      if (oldest === undefined) break;
      this.turns.delete(oldest);
    }
  }

  /** WAV bytes for a turn, or undefined if it was never captured or has been evicted. */
  getWav(turnId: string): Uint8Array | undefined {
    const entry = this.turns.get(turnId);
    return entry ? encodeWav(entry.samples, this.sampleRateHz) : undefined;
  }

  /** What audio is retained right now, oldest first. */
  list(): readonly RecordedTurnAudio[] {
    return [...this.turns.entries()].map(([turnId, entry]) => ({
      turnId,
      sampleRateHz: this.sampleRateHz,
      durationMs: Math.round((entry.samples.length / this.sampleRateHz) * 1000),
      byteLength: entry.samples.length * 2,
      truncated: entry.truncated,
    }));
  }

  /** Total retained audio in bytes — what a memory readout should show. */
  retainedBytes(): number {
    let total = 0;
    for (const entry of this.turns.values()) total += entry.samples.length * 2;
    return total;
  }

  reset(): void {
    this.preRoll = [];
    this.preRollLength = 0;
    this.open = undefined;
    this.pending = undefined;
    this.attributeOnSeal = undefined;
    this.turns.clear();
  }
}
