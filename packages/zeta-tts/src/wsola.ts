// SPDX-License-Identifier: MIT
//
// Streaming WSOLA (Waveform Similarity Overlap-Add) time-stretch.
// Pitch-preserving tempo control: tempo < 1 slows, > 1 speeds, 1.0 passthrough.
// Matches the intent of ffmpeg atempo without an ffmpeg runtime dependency.

const PASSTHROUGH_EPS = 1e-6;
const FRAME_MS = 0.03;
const SEARCH_MS = 0.01;
const INT16_MIN = -32768;
const INT16_MAX = 32767;

export class WsolaTimeStretch {
  private readonly passthrough: boolean;
  private readonly frame: number;
  private readonly hs: number;
  private readonly ha: number;
  private readonly searchRadius: number;
  private readonly window: Float64Array;

  /** Accumulated input samples (float). */
  private input: Float64Array = new Float64Array(0);
  private inputLen = 0;
  /** Absolute sample index of input[0] in the stream. */
  private inputOrigin = 0;

  /** Overlap-add synthesis buffer (float). */
  private ola: Float64Array = new Float64Array(0);
  private olaLen = 0;
  /** Absolute synthesis index of ola[0]. */
  private olaOrigin = 0;
  /**
   * Absolute synthesis index up to which samples are final (no further OLA).
   * After placing a frame at absSynth, samples in [0, absSynth) are complete.
   */
  private emitThrough = 0;

  /** Ideal analysis position (absolute input sample index). */
  private analysisPos = 0;
  /** Absolute synthesis index for the next frame. */
  private synthPos = 0;
  private havePrev = false;
  /** Natural continuation of previous frame (hs samples) for waveform matching. */
  private prevContinuation: Float64Array;

  constructor(tempo: number, sampleRateHz: number) {
    if (!(sampleRateHz > 0) || !Number.isFinite(sampleRateHz)) {
      throw new RangeError(`WsolaTimeStretch: invalid sampleRateHz ${String(sampleRateHz)}`);
    }
    if (!Number.isFinite(tempo) || tempo <= 0) {
      throw new RangeError(`WsolaTimeStretch: invalid tempo ${String(tempo)}`);
    }

    this.passthrough = Math.abs(tempo - 1) < PASSTHROUGH_EPS;
    this.frame = Math.max(2, Math.round(FRAME_MS * sampleRateHz));
    this.hs = Math.max(1, Math.floor(this.frame / 2));
    this.ha = Math.max(1, Math.round(this.hs * tempo));
    this.searchRadius = Math.max(0, Math.round(SEARCH_MS * sampleRateHz));
    this.window = hann(this.frame);
    this.prevContinuation = new Float64Array(this.hs);
  }

  process(input: Int16Array): Int16Array {
    if (this.passthrough) return input;
    if (input.length > 0) this.appendInput(input);
    return this.extractReady(false);
  }

  flush(): Int16Array {
    if (this.passthrough) return new Int16Array(0);
    return this.extractReady(true);
  }

  private appendInput(samples: Int16Array): void {
    this.ensureInputCapacity(this.inputLen + samples.length);
    for (let i = 0; i < samples.length; i++) {
      this.input[this.inputLen + i] = samples[i]!;
    }
    this.inputLen += samples.length;
  }

  private extractReady(flushing: boolean): Int16Array {
    while (this.tryAddFrame(flushing)) {
      // keep consuming frames while input allows
    }

    if (flushing) {
      this.emitThrough = this.olaOrigin + this.olaLen;
    }

    const ready = this.emitThrough - this.olaOrigin;
    if (ready <= 0) return new Int16Array(0);

    const out = new Int16Array(ready);
    for (let i = 0; i < ready; i++) {
      out[i] = clampInt16(this.ola[i]!);
    }

    const remaining = this.olaLen - ready;
    if (remaining > 0) {
      this.ola.copyWithin(0, ready, this.olaLen);
    }
    this.ola.fill(0, remaining, this.olaLen);
    this.olaLen = remaining;
    this.olaOrigin += ready;

    if (flushing) {
      this.inputLen = 0;
      this.inputOrigin = this.analysisPos;
    } else {
      this.compactInput();
    }

    return out;
  }

  /**
   * Place one more synthesis frame via WSOLA.
   * @returns false when more input is needed or the stream is exhausted.
   */
  private tryAddFrame(flushing: boolean): boolean {
    const frame = this.frame;
    const hs = this.hs;
    const search = this.searchRadius;
    const inputEnd = this.inputOrigin + this.inputLen;

    if (!this.havePrev) {
      if (inputEnd < frame) return false;
      const localStart = 0;
      this.olaAddFrame(localStart, 0);
      this.storeContinuation(localStart);
      this.havePrev = true;
      this.analysisPos = this.ha;
      this.synthPos = hs;
      // Samples [0, hs) still receive the next frame's OLA contribution.
      this.emitThrough = 0;
      return true;
    }

    // Need a full frame at some position in [ideal - search, ideal + search].
    const ideal = this.analysisPos;
    if (!flushing) {
      // Require full right-side search room so offsets are unbiased while streaming.
      if (inputEnd < ideal + frame + search) return false;
    } else {
      // On flush, accept any position that can hold a frame near the ideal.
      if (inputEnd < ideal - search + frame && inputEnd < frame) return false;
      if (inputEnd - this.inputOrigin < frame) return false;
      // If even the earliest searchable start cannot fit a frame, stop.
      const latestStart = inputEnd - frame;
      if (latestStart < Math.max(this.inputOrigin, ideal - search)) return false;
    }

    const bestLocal = this.findBestOffset(ideal);
    const absSynth = this.synthPos;
    this.olaAddFrame(bestLocal, absSynth);
    this.storeContinuation(bestLocal);
    this.analysisPos = ideal + this.ha;
    this.synthPos = absSynth + hs;
    // After placing frame at absSynth, no future frame touches [0, absSynth).
    this.emitThrough = absSynth;
    return true;
  }

  private findBestOffset(idealAbs: number): number {
    const frame = this.frame;
    const hs = this.hs;
    const search = this.searchRadius;
    const inputEnd = this.inputOrigin + this.inputLen;
    const earliest = Math.max(this.inputOrigin, idealAbs - search);
    const latest = Math.min(inputEnd - frame, idealAbs + search);

    if (latest < earliest) {
      const fallbackAbs = Math.min(
        Math.max(idealAbs, this.inputOrigin),
        Math.max(this.inputOrigin, inputEnd - frame),
      );
      return fallbackAbs - this.inputOrigin;
    }

    let bestLocal = earliest - this.inputOrigin;
    let bestScore = -Infinity;

    for (let abs = earliest; abs <= latest; abs++) {
      const local = abs - this.inputOrigin;
      let score = 0;
      for (let i = 0; i < hs; i++) {
        score += this.input[local + i]! * this.prevContinuation[i]!;
      }
      if (score > bestScore) {
        bestScore = score;
        bestLocal = local;
      }
    }
    return bestLocal;
  }

  private olaAddFrame(localStart: number, absSynth: number): void {
    const frame = this.frame;
    const localOla = absSynth - this.olaOrigin;
    const needLen = localOla + frame;
    this.ensureOlaCapacity(needLen);
    if (needLen > this.olaLen) {
      if (this.olaLen < localOla) {
        this.ola.fill(0, this.olaLen, localOla);
      }
      this.olaLen = needLen;
    }
    for (let i = 0; i < frame; i++) {
      const sample = localStart + i < this.inputLen ? this.input[localStart + i]! : 0;
      this.ola[localOla + i]! += sample * this.window[i]!;
    }
  }

  private storeContinuation(localStart: number): void {
    const hs = this.hs;
    for (let i = 0; i < hs; i++) {
      const idx = localStart + hs + i;
      this.prevContinuation[i] = idx < this.inputLen ? this.input[idx]! : 0;
    }
  }

  private compactInput(): void {
    const keepFromAbs = Math.max(0, this.analysisPos - this.searchRadius);
    if (keepFromAbs <= this.inputOrigin) return;
    const drop = keepFromAbs - this.inputOrigin;
    if (drop <= 0) return;
    if (drop >= this.inputLen) {
      this.inputLen = 0;
      this.inputOrigin = keepFromAbs;
      return;
    }
    this.input.copyWithin(0, drop, this.inputLen);
    this.inputLen -= drop;
    this.inputOrigin = keepFromAbs;
  }

  private ensureInputCapacity(needed: number): void {
    if (needed <= this.input.length) return;
    const cap = Math.max(needed, this.input.length > 0 ? this.input.length * 2 : 1024);
    const next = new Float64Array(cap);
    next.set(this.input.subarray(0, this.inputLen));
    this.input = next;
  }

  private ensureOlaCapacity(needed: number): void {
    if (needed <= this.ola.length) return;
    const cap = Math.max(needed, this.ola.length > 0 ? this.ola.length * 2 : 1024);
    const next = new Float64Array(cap);
    next.set(this.ola.subarray(0, this.olaLen));
    this.ola = next;
  }
}

/** Symmetric Hann window; 50% overlap is COLA (overlapping windows sum ≈ 1). */
function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  if (n === 1) {
    w[0] = 1;
    return w;
  }
  const denom = n - 1;
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / denom));
  }
  return w;
}

function clampInt16(x: number): number {
  const r = Math.round(x);
  if (r < INT16_MIN) return INT16_MIN;
  if (r > INT16_MAX) return INT16_MAX;
  return r;
}
