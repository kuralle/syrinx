// SPDX-License-Identifier: MIT
//
// ITU-T G.722 64 kbit/s sub-band ADPCM (16 kHz PCM16 ↔ G.722).
// Pure TypedArray — Workers-safe (no Buffer / node: / process).
//
// HONESTY: spec-implemented (ITU-T G.722 algorithm tables + QMF + dual-band
// ADPCM), round-trip-tested on speech-like signals. NOT ITU-vector-certified
// (authoritative ITU G.722 test vectors were not embedded). Unverified against
// a live carrier trunk negotiation.

/** 16 kHz wideband PCM sample rate for G.722. */
export const G722_SAMPLE_RATE_HZ = 16_000;

/** 64 kbit/s = 1 byte per pair of 16 kHz samples. */
export const G722_BITRATE = 64_000;

// ── ITU-T G.722 tables ──────────────────────────────────────────────────────

const QMF_FWD = Object.freeze([
  3, -11, 12, 32, -210, 951, 3876, -805, 362, -156, 53, -11,
]);
const QMF_REV = Object.freeze([
  -11, 53, -156, 362, -805, 3876, 951, -210, 32, 12, -11, 3,
]);

const QM2 = Object.freeze([-7408, -1616, 7408, 1616]);
const QM4 = Object.freeze([
  0, -20456, -12896, -8968, -6288, -4240, -2584, -1200, 20456, 12896, 8968, 6288, 4240, 2584, 1200, 0,
]);
const QM6 = Object.freeze([
  -136, -136, -136, -136, -24808, -21904, -19008, -16704, -14984, -13512, -12280, -11192, -10232, -9360, -8576, -7856,
  -7192, -6576, -6000, -5456, -4944, -4464, -4008, -3576, -3168, -2776, -2400, -2032, -1688, -1360, -1040, -728,
  24808, 21904, 19008, 16704, 14984, 13512, 12280, 11192, 10232, 9360, 8576, 7856, 7192, 6576, 6000, 5456,
  4944, 4464, 4008, 3576, 3168, 2776, 2400, 2032, 1688, 1360, 1040, 728, 432, 136, -432, -136,
]);
const Q6 = Object.freeze([
  0, 35, 72, 110, 150, 190, 233, 276, 323, 370, 422, 473, 530, 587, 650, 714, 786, 858, 940, 1023, 1121, 1219, 1339, 1458,
  1612, 1765, 1980, 2195, 2557, 2919, 0, 0,
]);
const ILB = Object.freeze([
  2048, 2093, 2139, 2186, 2233, 2282, 2332, 2383, 2435, 2489, 2543, 2599, 2656, 2714, 2774, 2834, 2896, 2960, 3025, 3091,
  3158, 3228, 3298, 3371, 3444, 3520, 3597, 3676, 3756, 3838, 3922, 4008,
]);
const ILN = Object.freeze([0, 63, 62, 31, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 0]);
const ILP = Object.freeze([0, 61, 60, 59, 58, 57, 56, 55, 54, 53, 52, 51, 50, 49, 48, 47, 46, 45, 44, 43, 42, 41, 40, 39, 38, 37, 36, 35, 34, 33, 32, 0]);
const IHN = Object.freeze([0, 1, 0]);
const IHP = Object.freeze([0, 3, 2]);
const WL = Object.freeze([-60, -30, 58, 172, 334, 538, 1198, 3042]);
const RL42 = Object.freeze([0, 7, 6, 5, 4, 3, 2, 1, 7, 6, 5, 4, 3, 2, 1, 0]);
const WH = Object.freeze([0, -214, 798]);
const RH2 = Object.freeze([2, 1, 2, 1]);

// ── helpers ─────────────────────────────────────────────────────────────────

function saturate16(amp: number): number {
  if (amp > 32767) return 32767;
  if (amp < -32768) return -32768;
  return amp | 0;
}

function saturate15(amp: number): number {
  if (amp > 16383) return 16383;
  if (amp < -16384) return -16384;
  return amp | 0;
}

function satAdd16(a: number, b: number): number {
  return saturate16(a + b);
}

function satSub16(a: number, b: number): number {
  return saturate16(a - b);
}

function circularDot(hist: Int16Array, coeffs: readonly number[], n: number, pos: number): number {
  let z = 0;
  for (let i = 0; i < n - pos; i += 1) z += hist[pos + i]! * coeffs[i]!;
  for (let i = 0; i < pos; i += 1) z += hist[i]! * coeffs[n - pos + i]!;
  return z;
}

interface BandState {
  nb: number;
  det: number;
  s: number;
  sz: number;
  r: number;
  p: [number, number];
  a: [number, number];
  b: [number, number, number, number, number, number];
  d: [number, number, number, number, number, number, number];
}

function createBand(det: number): BandState {
  return {
    nb: 0,
    det,
    s: 0,
    sz: 0,
    r: 0,
    p: [0, 0],
    a: [0, 0],
    b: [0, 0, 0, 0, 0, 0],
    d: [0, 0, 0, 0, 0, 0, 0],
  };
}

function block4(band: BandState, dx: number): void {
  const r = satAdd16(band.s, dx);
  const p = satAdd16(band.sz, dx);

  // UPPOL2
  let wd1 = saturate16(band.a[0] << 2);
  let wd32 = (p ^ band.p[0]) & 0x8000 ? wd1 : -wd1;
  if (wd32 > 32767) wd32 = 32767;
  let wd3 =
    (((p ^ band.p[1]) & 0x8000 ? -128 : 128) +
      (wd32 >> 7) +
      ((band.a[1] * 32512) >> 15)) |
    0;
  if (Math.abs(wd3) > 12288) wd3 = wd3 < 0 ? -12288 : 12288;
  const ap1 = wd3;

  // UPPOL1
  wd1 = (p ^ band.p[0]) & 0x8000 ? -192 : 192;
  let wd2 = ((band.a[0] * 32640) >> 15) | 0;
  let ap0 = satAdd16(wd1, wd2);
  wd3 = satSub16(15360, ap1);
  if (Math.abs(ap0) > wd3) ap0 = ap0 < 0 ? -wd3 : wd3;

  // FILTEP
  wd1 = satAdd16(r, r);
  wd1 = ((ap0 * wd1) >> 15) | 0;
  wd2 = satAdd16(band.r, band.r);
  wd2 = ((ap1 * wd2) >> 15) | 0;
  const sp = satAdd16(wd1, wd2);
  band.r = r;
  band.a[1] = ap1;
  band.a[0] = ap0;
  band.p[1] = band.p[0];
  band.p[0] = p;

  // UPZERO / DELAYA / FILTEZ
  wd1 = dx === 0 ? 0 : 128;
  band.d[0] = dx;
  let sz = 0;
  for (let i = 5; i >= 0; i -= 1) {
    wd2 = (band.d[i + 1]! ^ dx) & 0x8000 ? -wd1 : wd1;
    wd3 = ((band.b[i]! * 32640) >> 15) | 0;
    band.b[i] = satAdd16(wd2, wd3);
    wd3 = satAdd16(band.d[i]!, band.d[i]!);
    sz += (band.b[i]! * wd3) >> 15;
    band.d[i + 1] = band.d[i]!;
  }
  band.sz = saturate16(sz);
  band.s = satAdd16(sp, band.sz);
}

// ── public state + API ──────────────────────────────────────────────────────

export interface G722EncoderState {
  readonly _kind: "g722-encoder";
  ptr: number;
  x: Int16Array;
  y: Int16Array;
  band: [BandState, BandState];
  /** leftover sample when input length is odd */
  pending: number | null;
}

export interface G722DecoderState {
  readonly _kind: "g722-decoder";
  ptr: number;
  x: Int16Array;
  y: Int16Array;
  band: [BandState, BandState];
}

export function createG722EncoderState(): G722EncoderState {
  return {
    _kind: "g722-encoder",
    ptr: 0,
    x: new Int16Array(12),
    y: new Int16Array(12),
    band: [createBand(32), createBand(8)],
    pending: null,
  };
}

export function createG722DecoderState(): G722DecoderState {
  return {
    _kind: "g722-decoder",
    ptr: 0,
    x: new Int16Array(12),
    y: new Int16Array(12),
    band: [createBand(32), createBand(8)],
  };
}

/** Encode 16 kHz PCM16 → G.722 64 kbit/s bytes. Mutates `state`. Odd trailing sample is held for next call. */
export function encodeG722(state: G722EncoderState, pcm16: Int16Array): Uint8Array {
  let offset = 0;
  let samples = pcm16;
  if (state.pending !== null) {
    const merged = new Int16Array(pcm16.length + 1);
    merged[0] = state.pending;
    merged.set(pcm16, 1);
    samples = merged;
    state.pending = null;
  }
  if (samples.length % 2 !== 0) {
    state.pending = samples[samples.length - 1]!;
    samples = samples.subarray(0, samples.length - 1);
  }
  const out = new Uint8Array(samples.length >> 1);
  let outIdx = 0;

  while (offset < samples.length) {
    state.x[state.ptr] = samples[offset++]!;
    state.y[state.ptr] = samples[offset++]!;
    state.ptr += 1;
    if (state.ptr >= 12) state.ptr = 0;

    const sumodd = circularDot(state.x, QMF_FWD, 12, state.ptr);
    const sumeven = circularDot(state.y, QMF_REV, 12, state.ptr);
    const xlow = ((sumeven + sumodd) >> 14) | 0;
    const xhigh = ((sumeven - sumodd) >> 14) | 0;

    // Low band
    const el = satSub16(xlow, state.band[0].s);
    let wd = el >= 0 ? el : ~el;
    let i = 1;
    for (; i < 30; i += 1) {
      const wd1 = (Q6[i]! * state.band[0].det) >> 12;
      if (wd < wd1) break;
    }
    const ilow = el < 0 ? ILN[i]! : ILP[i]!;
    const ril = ilow >> 2;
    let dlow = ((state.band[0].det * QM4[ril]!) >> 15) | 0;
    const il4 = RL42[ril]!;
    wd = ((state.band[0].nb * 127) >> 7) + WL[il4]!;
    if (wd < 0) wd = 0;
    else if (wd > 18432) wd = 18432;
    state.band[0].nb = wd;
    let wd1 = (state.band[0].nb >> 6) & 31;
    let wd2 = 8 - (state.band[0].nb >> 11);
    let wd3 = wd2 < 0 ? ILB[wd1]! << -wd2 : ILB[wd1]! >> wd2;
    state.band[0].det = (wd3 << 2) | 0;
    block4(state.band[0], dlow);

    // High band
    const eh = satSub16(xhigh, state.band[1].s);
    wd = eh >= 0 ? eh : ~eh;
    wd1 = (564 * state.band[1].det) >> 12;
    const mih = wd >= wd1 ? 2 : 1;
    const ihigh = eh < 0 ? IHN[mih]! : IHP[mih]!;
    const dhigh = ((state.band[1].det * QM2[ihigh]!) >> 15) | 0;
    const ih2 = RH2[ihigh]!;
    wd = ((state.band[1].nb * 127) >> 7) + WH[ih2]!;
    if (wd < 0) wd = 0;
    else if (wd > 22528) wd = 22528;
    state.band[1].nb = wd;
    wd1 = (state.band[1].nb >> 6) & 31;
    wd2 = 10 - (state.band[1].nb >> 11);
    wd3 = wd2 < 0 ? ILB[wd1]! << -wd2 : ILB[wd1]! >> wd2;
    state.band[1].det = (wd3 << 2) | 0;
    block4(state.band[1], dhigh);

    out[outIdx++] = ((ihigh << 6) | ilow) & 0xff;
  }
  return outIdx === out.length ? out : out.subarray(0, outIdx);
}

/** Decode G.722 64 kbit/s bytes → 16 kHz PCM16. Mutates `state`. */
export function decodeG722(state: G722DecoderState, g722: Uint8Array): Int16Array {
  const out = new Int16Array(g722.byteLength * 2);
  let outIdx = 0;

  for (let j = 0; j < g722.byteLength; j += 1) {
    const code = g722[j]!;
    let wd1 = code & 0x3f;
    const ihigh = (code >> 6) & 0x03;
    let wd2 = QM6[wd1]!;
    wd1 >>= 2;

    // Low band INVQBL / RECONS / LIMIT
    wd2 = ((state.band[0].det * wd2) >> 15) | 0;
    const rlow = saturate15(state.band[0].s + wd2);

    // Low band INVQAL + LOGSCL + SCALEL
    wd2 = QM4[wd1]!;
    const dlow = ((state.band[0].det * wd2) >> 15) | 0;
    wd2 = RL42[wd1]!;
    let nb = ((state.band[0].nb * 127) >> 7) + WL[wd2]!;
    if (nb < 0) nb = 0;
    else if (nb > 18432) nb = 18432;
    state.band[0].nb = nb;
    let s1 = (state.band[0].nb >> 6) & 31;
    let s2 = 8 - (state.band[0].nb >> 11);
    let s3 = s2 < 0 ? ILB[s1]! << -s2 : ILB[s1]! >> s2;
    state.band[0].det = (s3 << 2) | 0;
    block4(state.band[0], dlow);

    // High band
    wd2 = QM2[ihigh]!;
    const dhigh = ((state.band[1].det * wd2) >> 15) | 0;
    const rhigh = saturate15(dhigh + state.band[1].s);
    wd2 = RH2[ihigh]!;
    nb = ((state.band[1].nb * 127) >> 7) + WH[wd2]!;
    if (nb < 0) nb = 0;
    else if (nb > 22528) nb = 22528;
    state.band[1].nb = nb;
    s1 = (state.band[1].nb >> 6) & 31;
    s2 = 10 - (state.band[1].nb >> 11);
    s3 = s2 < 0 ? ILB[s1]! << -s2 : ILB[s1]! >> s2;
    state.band[1].det = (s3 << 2) | 0;
    block4(state.band[1], dhigh);

    // QMF synthesis
    state.x[state.ptr] = (rlow + rhigh) | 0;
    state.y[state.ptr] = (rlow - rhigh) | 0;
    state.ptr += 1;
    if (state.ptr >= 12) state.ptr = 0;
    // QMF introduces ~22-sample group delay; polarity follows the ITU analysis/synthesis pair.
    out[outIdx++] = (circularDot(state.y, QMF_REV, 12, state.ptr) >> 11) | 0;
    out[outIdx++] = (circularDot(state.x, QMF_FWD, 12, state.ptr) >> 11) | 0;
  }
  return outIdx === out.length ? out : out.subarray(0, outIdx);
}
