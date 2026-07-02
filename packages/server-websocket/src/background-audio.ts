// SPDX-License-Identifier: MIT
//
// Background audio for the outbound path: a looped ambient bed (which doubles
// as telephony comfort noise between turns), an optional "thinking" loop keyed
// off the G3 tool-call cues, and ducking under assistant speech.
//
// Syrinx wires (Twilio media stream, browser jitter buffer) are single ORDERED
// streams — unlike LiveKit's WebRTC rooms there is no client-side track mixing
// — so background audio is mixed server-side into the one stream: `mix()` layers
// the bed under every TTS chunk (ducked), and `idleFrame()` produces bed-only
// frames for the gaps between turns. Source playback positions are shared
// between the two so the bed is seamless across turn boundaries.
//
// Runtime-neutral: no Node imports — runs on workerd (edge hosts) as-is.
// Prior art: Pipecat SoundfileMixer (transport-level mix + volume + loop),
// LiveKit BackgroundAudioPlayer (ambient/thinking split, state-keyed thinking).

import type { VoiceAgentSession } from "@kuralle-syrinx/core";
import { pcm16BytesToSamples, pcm16SamplesToBytes, resamplePcm16 } from "@kuralle-syrinx/core/audio";

export interface BackgroundAudioSource {
  /** Mono PCM16 samples. Must be loop-clean if it will loop audibly. */
  readonly pcm: Int16Array;
  readonly sampleRateHz: number;
  /** Linear gain 0..1 applied to this source. */
  readonly gain?: number;
}

export interface BackgroundAudioConfig {
  /** Looped continuously: under speech (ducked) and alone between turns. */
  readonly ambient?: BackgroundAudioSource;
  /** Looped while `setThinking(true)` — the audible face of a pending tool call. */
  readonly thinking?: BackgroundAudioSource;
  /**
   * Extra multiplier on background sources while assistant speech is being
   * mixed, so the bed never muddies the voice. 1 disables ducking. @default 0.5
   */
  readonly duckWhileSpeaking?: number;
  /**
   * Equal-power fade applied where the bed would otherwise hard-cut: the
   * ambient's very first samples, and each thinking episode's start and stop.
   * An abrupt full-volume onset is the harshest moment a caller hears from a
   * wait — the fade is what makes an episode feel placed rather than switched.
   * 0 disables. @default 250
   */
  readonly fadeMs?: number;
}

const DEFAULT_AMBIENT_GAIN = 0.25;
const DEFAULT_THINKING_GAIN = 0.4;
const DEFAULT_DUCK = 0.5;
const DEFAULT_FADE_MS = 250;

interface LoopedSource {
  readonly original: BackgroundAudioSource;
  readonly gain: number;
  /** Resampled variants cached per wire rate. */
  readonly byRate: Map<number, Int16Array>;
  /** Playback position in samples at the current wire rate. */
  position: number;
  positionRateHz: number;
}

function loopedSource(source: BackgroundAudioSource, defaultGain: number): LoopedSource {
  return {
    original: source,
    gain: source.gain ?? defaultGain,
    byRate: new Map(),
    position: 0,
    positionRateHz: source.sampleRateHz,
  };
}

function samplesAtRate(source: LoopedSource, rateHz: number): Int16Array {
  let samples = source.byRate.get(rateHz);
  if (!samples) {
    samples = resamplePcm16(source.original.pcm, source.original.sampleRateHz, rateHz);
    source.byRate.set(rateHz, samples);
  }
  if (source.positionRateHz !== rateHz) {
    // Wire rate changed mid-connection (rare): carry the position over proportionally.
    source.position = Math.round((source.position * rateHz) / source.positionRateHz);
    source.positionRateHz = rateHz;
  }
  return samples;
}

/**
 * Add samples of `source` (scaled by `scale`, optionally shaped per-sample by
 * `envelope(i)`) into `target`, advancing the loop.
 */
function addLooped(
  target: Float64Array,
  source: LoopedSource,
  rateHz: number,
  scale: number,
  envelope?: (i: number) => number,
): void {
  const samples = samplesAtRate(source, rateHz);
  if (samples.length === 0 || scale === 0) return;
  let pos = source.position % samples.length;
  for (let i = 0; i < target.length; i += 1) {
    const gain = envelope ? scale * envelope(i) : scale;
    target[i]! += samples[pos]! * gain;
    pos += 1;
    if (pos >= samples.length) pos = 0;
  }
  source.position = pos;
}

/** Equal-power fade-in gain for sample `n` of a `total`-sample ramp (1 past the ramp). */
function fadeInGain(n: number, total: number): number {
  if (total <= 0 || n >= total) return 1;
  return Math.sin((n / total) * (Math.PI / 2));
}

/** Equal-power fade-out gain for sample `n` of a `total`-sample ramp (0 past the ramp). */
function fadeOutGain(n: number, total: number): number {
  if (total <= 0 || n >= total) return 0;
  return Math.cos((n / total) * (Math.PI / 2));
}

function clipToPcm16Bytes(mix: Float64Array): Uint8Array {
  const out = new Int16Array(mix.length);
  for (let i = 0; i < mix.length; i += 1) {
    const v = Math.round(mix[i]!);
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return pcm16SamplesToBytes(out);
}

export class BackgroundAudioMixer {
  private readonly ambient: LoopedSource | null;
  private readonly thinking: LoopedSource | null;
  private readonly duck: number;
  private readonly fadeMs: number;
  /**
   * Thinking episode lifecycle: "stopping" keeps the loop audible for one
   * fade-out ramp after `setThinking(false)` instead of hard-cutting it.
   */
  private thinkingState: "off" | "on" | "stopping" = "off";
  /** Samples rendered since the current thinking episode started (fade-in). */
  private thinkingFadeInPos = 0;
  /** Samples rendered since the stop was requested (fade-out). */
  private thinkingFadeOutPos = 0;
  /** Samples of ambient rendered so far (one-time fade-in at bed start). */
  private ambientFadeInPos = 0;
  /** Realtime estimate of when already-mixed speech finishes playing out. */
  private speakingUntilMs = 0;

  constructor(config: BackgroundAudioConfig) {
    this.ambient = config.ambient ? loopedSource(config.ambient, DEFAULT_AMBIENT_GAIN) : null;
    this.thinking = config.thinking ? loopedSource(config.thinking, DEFAULT_THINKING_GAIN) : null;
    this.duck = config.duckWhileSpeaking ?? DEFAULT_DUCK;
    this.fadeMs = config.fadeMs ?? DEFAULT_FADE_MS;
  }

  get hasSources(): boolean {
    return this.ambient !== null || this.thinking !== null;
  }

  isSpeaking(nowMs = Date.now()): boolean {
    return nowMs < this.speakingUntilMs;
  }

  /** G3 cue wiring: started/delayed → true, complete/failed → false. */
  setThinking(on: boolean): void {
    if (on) {
      if (this.thinkingState === "on") return;
      this.thinkingState = "on";
      this.thinkingFadeInPos = 0;
      if (this.thinking) this.thinking.position = 0; // each episode starts from the top
      return;
    }
    if (this.thinkingState !== "on") return;
    // Audible for one fade-out ramp, then off (immediately off when fades are disabled).
    this.thinkingState = this.fadeMs > 0 ? "stopping" : "off";
    this.thinkingFadeOutPos = 0;
  }

  /**
   * Add the bed sources into `mixBuf` at `bedScale`, applying the fade
   * envelopes and advancing their positions/counters. Shared by mix (ducked)
   * and idleFrame (full gain) so episodes stay continuous across both.
   */
  private addBed(mixBuf: Float64Array, sampleRateHz: number, bedScale: number): void {
    const fadeSamples = Math.round((this.fadeMs / 1000) * sampleRateHz);

    if (this.ambient) {
      const startPos = this.ambientFadeInPos;
      const envelope = startPos >= fadeSamples
        ? undefined
        : (i: number) => fadeInGain(startPos + i, fadeSamples);
      addLooped(mixBuf, this.ambient, sampleRateHz, this.ambient.gain * bedScale, envelope);
      this.ambientFadeInPos = Math.min(fadeSamples, startPos + mixBuf.length);
    }

    if (this.thinking && this.thinkingState !== "off") {
      if (this.thinkingState === "on") {
        const startPos = this.thinkingFadeInPos;
        const envelope = startPos >= fadeSamples
          ? undefined
          : (i: number) => fadeInGain(startPos + i, fadeSamples);
        addLooped(mixBuf, this.thinking, sampleRateHz, this.thinking.gain * bedScale, envelope);
        this.thinkingFadeInPos = Math.min(fadeSamples, startPos + mixBuf.length);
      } else {
        const startPos = this.thinkingFadeOutPos;
        addLooped(
          mixBuf,
          this.thinking,
          sampleRateHz,
          this.thinking.gain * bedScale,
          (i: number) => fadeOutGain(startPos + i, fadeSamples),
        );
        this.thinkingFadeOutPos = startPos + mixBuf.length;
        if (this.thinkingFadeOutPos >= fadeSamples) this.thinkingState = "off";
      }
    }
  }

  /**
   * Mix the background bed (ducked) into an assistant speech chunk and advance
   * the speaking-until estimate by the chunk's realtime duration. Returns a new
   * buffer; the input is never mutated.
   */
  mix(chunk: Uint8Array, sampleRateHz: number, nowMs = Date.now()): Uint8Array {
    const speech = pcm16BytesToSamples(chunk);
    const durationMs = (speech.length / sampleRateHz) * 1000;
    this.speakingUntilMs = Math.max(this.speakingUntilMs, nowMs) + durationMs;

    if (!this.hasSources) return chunk;
    const mixBuf = new Float64Array(speech.length);
    for (let i = 0; i < speech.length; i += 1) mixBuf[i] = speech[i]!;
    this.addBed(mixBuf, sampleRateHz, this.duck);
    return clipToPcm16Bytes(mixBuf);
  }

  /**
   * Bed-only frame for the gaps between turns (telephony comfort noise), or
   * null while speech is still playing out / there is nothing to play.
   */
  idleFrame(frameMs: number, sampleRateHz: number, nowMs = Date.now()): Uint8Array | null {
    if (this.isSpeaking(nowMs)) return null;
    const playThinking = this.thinking !== null && this.thinkingState !== "off";
    if (!this.ambient && !playThinking) return null;

    const sampleCount = Math.max(1, Math.round((frameMs / 1000) * sampleRateHz));
    const mixBuf = new Float64Array(sampleCount);
    this.addBed(mixBuf, sampleRateHz, 1);
    return clipToPcm16Bytes(mixBuf);
  }
}

/**
 * Drive the mixer's thinking loop from the session's G3 tool-call cues:
 * started/delayed → thinking on; complete/failed → off. Listener lifetime is
 * the session's — both are per-connection.
 */
export function wireBackgroundThinking(session: VoiceAgentSession, mixer: BackgroundAudioMixer): void {
  session.on("tool_call_cue", (event) => {
    mixer.setThinking(event.phase === "started" || event.phase === "delayed");
  });
}
