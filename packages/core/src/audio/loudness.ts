// SPDX-License-Identifier: MIT

const INT16_MAX = 32767;
const DEFAULT_MAX_GAIN_STEP = 0.5;
const DEFAULT_RMS_SMOOTHING = 0.25;
const DEFAULT_CEILING = 30000;

export interface LoudnessConfig {
  readonly targetRms: number;
  readonly maxGainStep?: number;
  readonly rmsSmoothing?: number;
  readonly ceiling?: number;
}

export interface LoudnessState {
  gain: number;
  runningRms: number;
}

export function createLoudnessState(): LoudnessState {
  return { gain: 1, runningRms: 0 };
}

export function normalizeLoudness(
  pcm: Int16Array,
  state: LoudnessState,
  cfg: LoudnessConfig,
): Int16Array {
  const targetRms = positiveBounded(cfg.targetRms, "targetRms", INT16_MAX);
  const maxGainStep = positiveFinite(cfg.maxGainStep ?? DEFAULT_MAX_GAIN_STEP, "maxGainStep");
  const rmsSmoothing = bounded(cfg.rmsSmoothing ?? DEFAULT_RMS_SMOOTHING, "rmsSmoothing", 0, 1);
  const ceiling = positiveBounded(cfg.ceiling ?? DEFAULT_CEILING, "ceiling", INT16_MAX);

  if (pcm.length === 0) return pcm;

  const frameRms = rms(pcm);
  if (frameRms > 0) {
    state.runningRms =
      state.runningRms > 0
        ? state.runningRms + (frameRms - state.runningRms) * rmsSmoothing
        : frameRms;
    const desiredGain = targetRms / state.runningRms;
    const gainDelta = desiredGain - state.gain;
    state.gain += Math.max(-maxGainStep, Math.min(maxGainStep, gainDelta));
  }

  const output = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) {
    output[i] = Math.round(softLimit(pcm[i]! * state.gain, ceiling));
  }
  return output;
}

function rms(pcm: Int16Array): number {
  let sumSquares = 0;
  for (const sample of pcm) sumSquares += sample * sample;
  return Math.sqrt(sumSquares / pcm.length);
}

function softLimit(value: number, ceiling: number): number {
  const magnitude = Math.abs(value);
  const knee = ceiling * 0.75;
  if (magnitude <= knee) return value;
  const range = ceiling - knee;
  const limited = knee + range * (1 - Math.exp(-(magnitude - knee) / range));
  return Math.sign(value) * limited;
}

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`LoudnessConfig.${name} must be a positive finite number`);
  }
  return value;
}

function positiveBounded(value: number, name: string, max: number): number {
  const parsed = positiveFinite(value, name);
  if (parsed > max) throw new RangeError(`LoudnessConfig.${name} must be at most ${String(max)}`);
  return parsed;
}

function bounded(value: number, name: string, min: number, max: number): number {
  if (!Number.isFinite(value) || value <= min || value > max) {
    throw new RangeError(`LoudnessConfig.${name} must be greater than ${String(min)} and at most ${String(max)}`);
  }
  return value;
}
