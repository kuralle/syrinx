// SPDX-License-Identifier: MIT
//
// VE-02 / G23 — lightweight primary-speaker gate for barge-in (FireRedChat pVAD direction).
// Locks a spectral fingerprint from the first user turn; gates sustained barge-in on match.

import { pcm16BytesToSamples } from "./audio/pcm.js";

const SAMPLE_RATE_HZ = 16000;
const MIN_SAMPLES = 320;
const BAND_HZ = [150, 300, 600, 1200, 2400, 4800] as const;

export interface SpeakerFingerprint {
  readonly bands: readonly number[];
  readonly rms: number;
  readonly zcr: number;
}

export interface PrimarySpeakerGateConfig {
  readonly enabled?: boolean;
  readonly similarityThreshold?: number;
  readonly echoDominanceMargin?: number;
}

export class PrimarySpeakerGate {
  private readonly enabled: boolean;
  private readonly similarityThreshold: number;
  private readonly echoDominanceMargin: number;
  private profile: SpeakerFingerprint | null = null;
  private enrollFrames: SpeakerFingerprint[] = [];
  private bargeInFrames: SpeakerFingerprint[] = [];
  private assistantProfile: SpeakerFingerprint | null = null;

  constructor(config: PrimarySpeakerGateConfig = {}) {
    this.enabled = config.enabled !== false;
    this.similarityThreshold = config.similarityThreshold ?? 0.72;
    this.echoDominanceMargin = config.echoDominanceMargin ?? 0.12;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  hasProfile(): boolean {
    return this.profile !== null;
  }

  enrollUserTurnChunk(pcm: Uint8Array): void {
    if (!this.enabled || this.profile !== null) return;
    const frame = extractSpeakerFingerprint(pcm);
    if (frame) this.enrollFrames.push(frame);
  }

  lockProfileFromFirstTurn(): void {
    if (!this.enabled || this.profile !== null || this.enrollFrames.length === 0) return;
    this.profile = averageFingerprints(this.enrollFrames);
    this.enrollFrames = [];
  }

  beginBargeInWindow(): void {
    this.bargeInFrames = [];
  }

  observeBargeInChunk(pcm: Uint8Array): void {
    if (!this.enabled) return;
    const frame = extractSpeakerFingerprint(pcm);
    if (frame) this.bargeInFrames.push(frame);
  }

  observeAssistantPlayout(pcm: Uint8Array): void {
    if (!this.enabled) return;
    const frame = extractSpeakerFingerprint(pcm);
    if (!frame) return;
    this.assistantProfile = frame;
  }

  shouldCommitBargeIn(): boolean {
    if (!this.enabled || this.profile === null) return true;
    if (this.bargeInFrames.length === 0) return false;

    let primaryHits = 0;
    for (const frame of this.bargeInFrames) {
      const primarySim = fingerprintSimilarity(frame, this.profile);
      if (this.assistantProfile !== null) {
        const echoSim = fingerprintSimilarity(frame, this.assistantProfile);
        if (echoSim >= this.similarityThreshold) continue;
        if (echoSim >= primarySim + this.echoDominanceMargin) continue;
      }
      if (primarySim >= this.similarityThreshold) primaryHits += 1;
    }

    const required = Math.max(1, Math.ceil(this.bargeInFrames.length * 0.45));
    return primaryHits >= required;
  }

  resetBargeInWindow(): void {
    this.bargeInFrames = [];
  }
}

export function extractSpeakerFingerprint(pcm: Uint8Array): SpeakerFingerprint | null {
  if (pcm.byteLength < MIN_SAMPLES * 2) return null;
  let samples: Int16Array;
  try {
    samples = pcm16BytesToSamples(pcm);
  } catch {
    return null;
  }
  if (samples.length < MIN_SAMPLES) return null;

  const window = samples.length > 512 ? samples.subarray(0, 512) : samples;
  const bands = BAND_HZ.map((hz) => goertzelMagnitude(window, hz, SAMPLE_RATE_HZ));
  const maxBand = Math.max(...bands, 1e-9);
  const normalizedBands = bands.map((b) => b / maxBand);

  let sumSq = 0;
  let crossings = 0;
  let prev = window[0]! >= 0;
  for (let i = 0; i < window.length; i += 1) {
    const s = window[i]!;
    sumSq += s * s;
    const positive = s >= 0;
    if (i > 0 && positive !== prev) crossings += 1;
    prev = positive;
  }
  const rms = Math.sqrt(sumSq / window.length) / 32768;
  const zcr = crossings / window.length;

  return { bands: normalizedBands, rms, zcr };
}

export function fingerprintSimilarity(a: SpeakerFingerprint, b: SpeakerFingerprint): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.bands.length; i += 1) {
    const av = a.bands[i] ?? 0;
    const bv = b.bands[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom <= 0) return 0;

  const spectral = dot / denom;
  const rmsDelta = Math.abs(a.rms - b.rms);
  const zcrDelta = Math.abs(a.zcr - b.zcr);
  const timbrePenalty = Math.min(1, rmsDelta * 4 + zcrDelta * 2);
  return Math.max(0, spectral * (1 - timbrePenalty * 0.35));
}

function averageFingerprints(frames: SpeakerFingerprint[]): SpeakerFingerprint {
  const bandCount = frames[0]!.bands.length;
  const bands = new Array<number>(bandCount).fill(0);
  let rms = 0;
  let zcr = 0;
  for (const frame of frames) {
    rms += frame.rms;
    zcr += frame.zcr;
    for (let i = 0; i < bandCount; i += 1) {
      bands[i] = (bands[i] ?? 0) + (frame.bands[i] ?? 0);
    }
  }
  const n = frames.length;
  return {
    bands: bands.map((b) => b / n),
    rms: rms / n,
    zcr: zcr / n,
  };
}

function goertzelMagnitude(samples: Int16Array, targetHz: number, sampleRateHz: number): number {
  const omega = (2 * Math.PI * targetHz) / sampleRateHz;
  const coeff = 2 * Math.cos(omega);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const x = samples[i]! / 32768;
    s0 = x + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const real = s1 - s2 * Math.cos(omega);
  const imag = s2 * Math.sin(omega);
  return Math.sqrt(real * real + imag * imag);
}
