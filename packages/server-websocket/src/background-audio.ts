// SPDX-License-Identifier: MIT
//
// Background audio for the outbound path: a looped ambient bed (which doubles
// as telephony comfort noise between turns), an optional "thinking" loop keyed
// off the G3 tool-call cues, one-shot backchannel cues, and ducking under speech.
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

import type { InteractionBackchannelPacket, VoiceAgentSession } from "@kuralle-syrinx/core";
import { Route } from "@kuralle-syrinx/core";
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
  /** Pre-cached one-shot backchannel cues keyed by cue id (IP-C3). */
  readonly cues?: Readonly<Record<string, BackgroundAudioSource>>;
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
const DEFAULT_CUE_GAIN = 0.65;
const DEFAULT_DUCK = 0.5;
const DEFAULT_FADE_MS = 250;
const CUE_THINKING_DUCK = 0.25;

interface LoopedSource {
  readonly original: BackgroundAudioSource;
  readonly gain: number;
  /** Resampled variants cached per wire rate. */
  readonly byRate: Map<number, Int16Array>;
  /** Playback position in samples at the current wire rate. */
  position: number;
  positionRateHz: number;
}

interface OneShotSource {
  readonly original: BackgroundAudioSource;
  readonly gain: number;
  readonly byRate: Map<number, Int16Array>;
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

function oneShotSource(source: BackgroundAudioSource, defaultGain: number): OneShotSource {
  return {
    original: source,
    gain: source.gain ?? defaultGain,
    byRate: new Map(),
    position: 0,
    positionRateHz: source.sampleRateHz,
  };
}

function samplesAtRate(
  source: LoopedSource | OneShotSource,
  rateHz: number,
): Int16Array {
  let samples = source.byRate.get(rateHz);
  if (!samples) {
    samples = resamplePcm16(source.original.pcm, source.original.sampleRateHz, rateHz);
    source.byRate.set(rateHz, samples);
  }
  if (source.positionRateHz !== rateHz) {
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

function addOneShot(target: Float64Array, source: OneShotSource, rateHz: number): boolean {
  const samples = samplesAtRate(source, rateHz);
  if (samples.length === 0 || source.gain === 0) return true;
  let pos = source.position;
  for (let i = 0; i < target.length; i += 1) {
    if (pos >= samples.length) {
      source.position = samples.length;
      return true;
    }
    target[i]! += samples[pos]! * source.gain;
    pos += 1;
  }
  source.position = pos;
  return pos >= samples.length;
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
  private readonly cueCatalog: ReadonlyMap<string, BackgroundAudioSource>;
  private readonly duck: number;
  private readonly fadeMs: number;
  private thinkingState: "off" | "on" | "stopping" = "off";
  private thinkingFadeInPos = 0;
  private thinkingFadeOutPos = 0;
  private ambientFadeInPos = 0;
  private speakingUntilMs = 0;
  private pendingCue: OneShotSource | null = null;

  constructor(config: BackgroundAudioConfig) {
    this.ambient = config.ambient ? loopedSource(config.ambient, DEFAULT_AMBIENT_GAIN) : null;
    this.thinking = config.thinking ? loopedSource(config.thinking, DEFAULT_THINKING_GAIN) : null;
    this.cueCatalog = new Map(Object.entries(config.cues ?? {}));
    this.duck = config.duckWhileSpeaking ?? DEFAULT_DUCK;
    this.fadeMs = config.fadeMs ?? DEFAULT_FADE_MS;
  }

  get hasSources(): boolean {
    return this.ambient !== null || this.thinking !== null || this.cueCatalog.size > 0;
  }

  hasCue(cueId: string): boolean {
    return this.cueCatalog.has(cueId);
  }

  isSpeaking(nowMs = Date.now()): boolean {
    return nowMs < this.speakingUntilMs;
  }

  /** Queue a one-shot backchannel cue by id. Returns false when the cue is unknown. */
  queueCue(cueId: string): boolean {
    const source = this.cueCatalog.get(cueId);
    if (!source) return false;
    this.pendingCue = oneShotSource(source, DEFAULT_CUE_GAIN);
    return true;
  }

  /** G3 cue wiring: started/delayed → true, complete/failed → false. */
  setThinking(on: boolean): void {
    if (on) {
      if (this.thinkingState === "on") return;
      this.thinkingState = "on";
      this.thinkingFadeInPos = 0;
      if (this.thinking) this.thinking.position = 0;
      return;
    }
    if (this.thinkingState !== "on") return;
    this.thinkingState = this.fadeMs > 0 ? "stopping" : "off";
    this.thinkingFadeOutPos = 0;
  }

  private thinkingScale(bedScale: number): number {
    return this.pendingCue ? bedScale * CUE_THINKING_DUCK : bedScale;
  }

  private addBed(mixBuf: Float64Array, sampleRateHz: number, bedScale: number): void {
    const fadeSamples = Math.round((this.fadeMs / 1000) * sampleRateHz);
    const thinkingScale = this.thinkingScale(bedScale);

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
        addLooped(mixBuf, this.thinking, sampleRateHz, this.thinking.gain * thinkingScale, envelope);
        this.thinkingFadeInPos = Math.min(fadeSamples, startPos + mixBuf.length);
      } else {
        const startPos = this.thinkingFadeOutPos;
        addLooped(
          mixBuf,
          this.thinking,
          sampleRateHz,
          this.thinking.gain * thinkingScale,
          (i: number) => fadeOutGain(startPos + i, fadeSamples),
        );
        this.thinkingFadeOutPos = startPos + mixBuf.length;
        if (this.thinkingFadeOutPos >= fadeSamples) this.thinkingState = "off";
      }
    }
  }

  private addPendingCue(mixBuf: Float64Array, sampleRateHz: number): void {
    if (!this.pendingCue) return;
    const finished = addOneShot(mixBuf, this.pendingCue, sampleRateHz);
    if (finished) this.pendingCue = null;
  }

  mix(chunk: Uint8Array, sampleRateHz: number, nowMs = Date.now()): Uint8Array {
    const speech = pcm16BytesToSamples(chunk);
    const durationMs = (speech.length / sampleRateHz) * 1000;
    this.speakingUntilMs = Math.max(this.speakingUntilMs, nowMs) + durationMs;

    if (!this.hasSources && !this.pendingCue) return chunk;
    const mixBuf = new Float64Array(speech.length);
    for (let i = 0; i < speech.length; i += 1) mixBuf[i] = speech[i]!;
    this.addBed(mixBuf, sampleRateHz, this.duck);
    return clipToPcm16Bytes(mixBuf);
  }

  idleFrame(frameMs: number, sampleRateHz: number, nowMs = Date.now()): Uint8Array | null {
    if (this.isSpeaking(nowMs)) return null;
    const playThinking = this.thinking !== null && this.thinkingState !== "off";
    if (!this.ambient && !playThinking && !this.pendingCue) return null;

    const sampleCount = Math.max(1, Math.round((frameMs / 1000) * sampleRateHz));
    const mixBuf = new Float64Array(sampleCount);
    this.addBed(mixBuf, sampleRateHz, 1);
    this.addPendingCue(mixBuf, sampleRateHz);
    return clipToPcm16Bytes(mixBuf);
  }
}

export function wireBackgroundThinking(session: VoiceAgentSession, mixer: BackgroundAudioMixer): void {
  session.on("tool_call_cue", (event) => {
    mixer.setThinking(event.phase === "started" || event.phase === "delayed");
  });
}

export function wireBackgroundBackchannel(session: VoiceAgentSession, mixer: BackgroundAudioMixer): void {
  session.bus.on("interaction.backchannel", (pkt) => {
    const backchannel = pkt as InteractionBackchannelPacket;
    if (mixer.queueCue(backchannel.cue)) return;
    session.bus.push(Route.Background, {
      kind: "metric.conversation",
      contextId: backchannel.contextId,
      timestampMs: backchannel.timestampMs,
      name: "backchannel.suppressed_missing_asset",
      value: backchannel.cue,
    });
  });
}

export function wireBackgroundAudio(session: VoiceAgentSession, mixer: BackgroundAudioMixer): void {
  wireBackgroundThinking(session, mixer);
  wireBackgroundBackchannel(session, mixer);
}