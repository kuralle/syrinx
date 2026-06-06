// SPDX-License-Identifier: MIT

import { describe, expect, it, vi } from "vitest";
import {
  PrimarySpeakerGate,
  extractSpeakerFingerprint,
  fingerprintSimilarity,
} from "./primary-speaker-gate.js";
import * as primarySpeakerGateModule from "./primary-speaker-gate.js";
import {
  ASSISTANT_ECHO_TONE_HZ,
  BYSTANDER_SPEAKER_TONE_HZ,
  PRIMARY_SPEAKER_TONE_HZ,
  mixPcm16,
  synthesizeTonePcm16,
} from "./primary-speaker-fixtures.js";

describe("extractSpeakerFingerprint", () => {
  it("separates distinct synthetic speakers by band shape", () => {
    const primary = extractSpeakerFingerprint(
      synthesizeTonePcm16({ frequencyHz: PRIMARY_SPEAKER_TONE_HZ, durationMs: 40 }),
    );
    const bystander = extractSpeakerFingerprint(
      synthesizeTonePcm16({ frequencyHz: BYSTANDER_SPEAKER_TONE_HZ, durationMs: 40 }),
    );
    expect(primary).not.toBeNull();
    expect(bystander).not.toBeNull();
    const self = fingerprintSimilarity(primary!, primary!);
    const cross = fingerprintSimilarity(primary!, bystander!);
    expect(self).toBeGreaterThan(0.95);
    expect(cross).toBeLessThan(0.72);
  });
});

describe("PrimarySpeakerGate", () => {
  it("commits barge-in for primary-only sustained speech", () => {
    const gate = new PrimarySpeakerGate();
    const primary = synthesizeTonePcm16({ frequencyHz: PRIMARY_SPEAKER_TONE_HZ, durationMs: 32 });
    gate.enrollUserTurnChunk(primary);
    gate.lockProfileFromFirstTurn();
    gate.beginBargeInWindow();
    for (let i = 0; i < 6; i += 1) {
      gate.observeBargeInChunk(primary);
    }
    expect(gate.shouldCommitBargeIn()).toBe(true);
  });

  it("suppresses bystander sustained speech", () => {
    const gate = new PrimarySpeakerGate();
    gate.enrollUserTurnChunk(
      synthesizeTonePcm16({ frequencyHz: PRIMARY_SPEAKER_TONE_HZ, durationMs: 32 }),
    );
    gate.lockProfileFromFirstTurn();
    gate.beginBargeInWindow();
    const bystander = synthesizeTonePcm16({ frequencyHz: BYSTANDER_SPEAKER_TONE_HZ, durationMs: 32 });
    for (let i = 0; i < 8; i += 1) {
      gate.observeBargeInChunk(bystander);
    }
    expect(gate.shouldCommitBargeIn()).toBe(false);
  });

  it("suppresses assistant echo over primary profile", () => {
    const gate = new PrimarySpeakerGate();
    gate.enrollUserTurnChunk(
      synthesizeTonePcm16({ frequencyHz: PRIMARY_SPEAKER_TONE_HZ, durationMs: 32 }),
    );
    gate.lockProfileFromFirstTurn();
    const echo = synthesizeTonePcm16({
      frequencyHz: ASSISTANT_ECHO_TONE_HZ,
      durationMs: 32,
      amplitude: 0.2,
    });
    gate.observeAssistantPlayout(
      synthesizeTonePcm16({ frequencyHz: ASSISTANT_ECHO_TONE_HZ, durationMs: 32 }),
    );
    gate.beginBargeInWindow();
    for (let i = 0; i < 8; i += 1) {
      gate.observeBargeInChunk(echo);
    }
    expect(gate.shouldCommitBargeIn()).toBe(false);
  });

  it("falls back to permissive commit when no profile is locked", () => {
    const gate = new PrimarySpeakerGate();
    gate.beginBargeInWindow();
    gate.observeBargeInChunk(
      synthesizeTonePcm16({ frequencyHz: BYSTANDER_SPEAKER_TONE_HZ, durationMs: 32 }),
    );
    expect(gate.hasProfile()).toBe(false);
    expect(gate.shouldCommitBargeIn()).toBe(true);
  });

  it("commits barge-in when primary similarity beats echo even above threshold", () => {
    const gate = new PrimarySpeakerGate({ similarityThreshold: 0.72, echoDominanceMargin: 0.12 });
    const primary = synthesizeTonePcm16({ frequencyHz: PRIMARY_SPEAKER_TONE_HZ, durationMs: 32 });
    gate.enrollUserTurnChunk(primary);
    gate.lockProfileFromFirstTurn();
    gate.observeAssistantPlayout(
      synthesizeTonePcm16({ frequencyHz: ASSISTANT_ECHO_TONE_HZ, durationMs: 32 }),
    );

    const profile = (gate as unknown as { profile: NonNullable<ReturnType<typeof extractSpeakerFingerprint>> }).profile;
    const assistantProfile = (gate as unknown as {
      assistantProfile: NonNullable<ReturnType<typeof extractSpeakerFingerprint>>;
    }).assistantProfile;

    vi.spyOn(primarySpeakerGateModule, "fingerprintSimilarity").mockImplementation((_frame, reference) => {
      if (reference === profile) return 0.95;
      if (reference === assistantProfile) return 0.73;
      return 0;
    });

    gate.beginBargeInWindow();
    for (let i = 0; i < 6; i += 1) {
      gate.observeBargeInChunk(primary);
    }
    expect(gate.shouldCommitBargeIn()).toBe(true);
    vi.restoreAllMocks();
  });

  it("allows mixed audio when primary dominates", () => {
    const gate = new PrimarySpeakerGate();
    const primary = synthesizeTonePcm16({ frequencyHz: PRIMARY_SPEAKER_TONE_HZ, durationMs: 32 });
    gate.enrollUserTurnChunk(primary);
    gate.lockProfileFromFirstTurn();
    const mixed = mixPcm16(
      [
        synthesizeTonePcm16({ frequencyHz: PRIMARY_SPEAKER_TONE_HZ, durationMs: 32 }),
        synthesizeTonePcm16({ frequencyHz: BYSTANDER_SPEAKER_TONE_HZ, durationMs: 32, amplitude: 0.08 }),
      ],
      [1, 1],
    );
    gate.beginBargeInWindow();
    for (let i = 0; i < 6; i += 1) {
      gate.observeBargeInChunk(mixed);
    }
    expect(gate.shouldCommitBargeIn()).toBe(true);
  });

  it("mixes PCM chunks whose byteOffset is odd", () => {
    const primary = synthesizeTonePcm16({ frequencyHz: PRIMARY_SPEAKER_TONE_HZ, durationMs: 32 });
    const backing = new Uint8Array(primary.byteLength + 1);
    backing.set(primary, 1);
    const oddOffsetPrimary = backing.subarray(1);
    expect(oddOffsetPrimary.byteOffset % 2).toBe(1);

    expect(() => mixPcm16([oddOffsetPrimary], [1])).not.toThrow();
    expect(mixPcm16([oddOffsetPrimary], [1])).toEqual(primary);
  });
});
