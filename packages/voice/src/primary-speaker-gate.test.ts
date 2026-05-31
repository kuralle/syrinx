// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { PrimarySpeakerGate, extractSpeakerFingerprint, fingerprintSimilarity } from "./primary-speaker-gate.js";
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
});
