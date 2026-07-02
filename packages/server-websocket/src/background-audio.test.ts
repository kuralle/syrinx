// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { BackgroundAudioMixer } from "./background-audio.js";

function pcmBytes(samples: number[]): Uint8Array {
  return new Uint8Array(Int16Array.from(samples).buffer.slice(0));
}

function samplesOf(bytes: Uint8Array): number[] {
  return Array.from(new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2));
}

/** Constant-value ambient source: every mixed sample adds value*gain. */
function constantSource(value: number, length = 160, sampleRateHz = 16000) {
  return { pcm: new Int16Array(length).fill(value), sampleRateHz };
}

describe("BackgroundAudioMixer", () => {
  it("mixes ducked ambient into a TTS chunk and full-gain ambient into idle frames", () => {
    const mixer = new BackgroundAudioMixer({
      ambient: { ...constantSource(1000), gain: 0.5 },
      duckWhileSpeaking: 0.5,
      fadeMs: 0,
    });

    const t0 = 1_000_000;
    const mixed = mixer.mix(pcmBytes([0, 0, 0, 0]), 16000, t0);
    // ambient 1000 * gain 0.5 * duck 0.5 = 250 on top of silence
    expect(samplesOf(mixed)).toEqual([250, 250, 250, 250]);

    // Once speech has drained, the idle frame carries ambient at full gain.
    const idle = mixer.idleFrame(1, 16000, t0 + 10_000);
    expect(idle).not.toBeNull();
    expect(samplesOf(idle!)).toEqual(Array(16).fill(500)); // 1ms @16k = 16 samples, 1000*0.5
  });

  it("suppresses idle frames while speech is still playing out", () => {
    const mixer = new BackgroundAudioMixer({ ambient: constantSource(1000), fadeMs: 0 });
    const t0 = 2_000_000;
    // 160 samples @16k = 10ms of speech → speaking until t0+10.
    mixer.mix(pcmBytes(Array(160).fill(0)), 16000, t0);
    expect(mixer.isSpeaking(t0 + 5)).toBe(true);
    expect(mixer.idleFrame(20, 16000, t0 + 5)).toBeNull();
    expect(mixer.isSpeaking(t0 + 11)).toBe(false);
    expect(mixer.idleFrame(20, 16000, t0 + 11)).not.toBeNull();
  });

  it("keeps the ambient position continuous across mix and idle frames", () => {
    // Ramp source so position is observable: sample i has value i.
    const ramp = Int16Array.from({ length: 1000 }, (_, i) => i);
    const mixer = new BackgroundAudioMixer({
      ambient: { pcm: ramp, sampleRateHz: 16000, gain: 1 },
      duckWhileSpeaking: 1,
      fadeMs: 0,
    });
    const t0 = 3_000_000;
    const first = mixer.mix(pcmBytes([0, 0, 0, 0]), 16000, t0);
    expect(samplesOf(first)).toEqual([0, 1, 2, 3]);
    const idle = mixer.idleFrame(1, 16000, t0 + 1000);
    expect(samplesOf(idle!)[0]).toBe(4); // continues where mix left off
    const next = mixer.mix(pcmBytes([0, 0]), 16000, t0 + 2000);
    expect(samplesOf(next)).toEqual([20, 21]); // 4 + 16 idle samples consumed
  });

  it("loops the ambient source past its end", () => {
    const ramp = Int16Array.from({ length: 4 }, (_, i) => i + 1); // 1,2,3,4
    const mixer = new BackgroundAudioMixer({
      ambient: { pcm: ramp, sampleRateHz: 16000, gain: 1 },
      duckWhileSpeaking: 1,
      fadeMs: 0,
    });
    const mixed = mixer.mix(pcmBytes(Array(10).fill(0)), 16000, 4_000_000);
    expect(samplesOf(mixed)).toEqual([1, 2, 3, 4, 1, 2, 3, 4, 1, 2]);
  });

  it("plays the thinking loop only while thinking, and restarts it fresh each episode", () => {
    const ramp = Int16Array.from({ length: 100 }, (_, i) => i);
    const mixer = new BackgroundAudioMixer({
      thinking: { pcm: ramp, sampleRateHz: 16000, gain: 1 },
      fadeMs: 0,
    });
    const t0 = 5_000_000;
    expect(mixer.idleFrame(1, 16000, t0)).toBeNull(); // nothing to play

    mixer.setThinking(true);
    const a = mixer.idleFrame(1, 16000, t0);
    expect(samplesOf(a!)).toEqual(Array.from({ length: 16 }, (_, i) => i));

    mixer.setThinking(false);
    expect(mixer.idleFrame(1, 16000, t0)).toBeNull();

    mixer.setThinking(true); // new episode restarts at 0
    const b = mixer.idleFrame(1, 16000, t0);
    expect(samplesOf(b!)[0]).toBe(0);
  });

  it("resamples sources to the wire rate once and mixes correctly", () => {
    // 8k constant source mixed into a 16k chunk: values unchanged, length follows the chunk.
    const mixer = new BackgroundAudioMixer({
      ambient: { pcm: new Int16Array(80).fill(800), sampleRateHz: 8000, gain: 1 },
      duckWhileSpeaking: 1,
      fadeMs: 0,
    });
    const mixed = mixer.mix(pcmBytes(Array(8).fill(0)), 16000, 6_000_000);
    expect(samplesOf(mixed)).toEqual(Array(8).fill(800));
  });

  it("clips the sum to int16 range", () => {
    const mixer = new BackgroundAudioMixer({
      ambient: { pcm: new Int16Array(16).fill(20000), sampleRateHz: 16000, gain: 1 },
      duckWhileSpeaking: 1,
      fadeMs: 0,
    });
    const mixed = mixer.mix(pcmBytes([30000, -30000]), 16000, 7_000_000);
    expect(samplesOf(mixed)).toEqual([32767, -10000]);
  });

  it("passes TTS through untouched when no sources are configured", () => {
    const mixer = new BackgroundAudioMixer({});
    const chunk = pcmBytes([1, 2, 3]);
    expect(samplesOf(mixer.mix(chunk, 16000, 8_000_000))).toEqual([1, 2, 3]);
    expect(mixer.idleFrame(20, 16000, 8_000_000)).toBeNull();
    expect(mixer.hasSources).toBe(false);
  });

  it("fades the ambient bed in at start instead of hard-cutting (equal-power ramp)", () => {
    // fadeMs 1 @ 16k = 16-sample ramp.
    const mixer = new BackgroundAudioMixer({
      ambient: { ...constantSource(1000), gain: 1 },
      fadeMs: 1,
    });
    const first = mixer.idleFrame(1, 16000, 9_000_000)!;
    const samples = samplesOf(first);
    expect(samples[0]).toBe(0); // sin(0) = 0
    expect(samples[8]!).toBeGreaterThan(400); // mid-ramp
    expect(samples[8]!).toBeLessThan(900);
    // Past the ramp: full gain, permanently.
    const second = mixer.idleFrame(1, 16000, 9_000_100)!;
    expect(samplesOf(second)).toEqual(Array(16).fill(1000));
  });

  it("fades the thinking loop out on stop, then goes silent", () => {
    const mixer = new BackgroundAudioMixer({
      thinking: { pcm: new Int16Array(1000).fill(1000), sampleRateHz: 16000, gain: 1 },
      fadeMs: 1, // 16-sample ramps
    });
    const t0 = 10_000_000;
    mixer.setThinking(true);
    mixer.idleFrame(2, 16000, t0); // ride past the fade-in
    const steady = mixer.idleFrame(1, 16000, t0 + 100)!;
    expect(samplesOf(steady)).toEqual(Array(16).fill(1000));

    mixer.setThinking(false);
    const fading = mixer.idleFrame(1, 16000, t0 + 200)!; // one fade-out ramp, decaying
    const fadeSamples = samplesOf(fading);
    expect(fadeSamples[0]).toBe(1000); // cos(0) = 1
    expect(fadeSamples[15]!).toBeLessThan(250); // near the end of the ramp
    expect(mixer.idleFrame(1, 16000, t0 + 300)).toBeNull(); // episode fully over
  });

  it("fades each new thinking episode in from silence", () => {
    const mixer = new BackgroundAudioMixer({
      thinking: { pcm: new Int16Array(1000).fill(1000), sampleRateHz: 16000, gain: 1 },
      fadeMs: 1,
    });
    mixer.setThinking(true);
    const first = mixer.idleFrame(1, 16000, 11_000_000)!;
    expect(samplesOf(first)[0]).toBe(0); // soft entry, not a hard cut
  });
});
