// SPDX-License-Identifier: MIT
//
// Fixture sidecar loading for `syrinx turn --in <fixture.json>`. Mirrors the
// shape written by apps/studio/src/lib/fixture-export.ts ("Save as fixture") and
// the check already proven in examples/02-hello-voice-headless/scripts/replay-fixture.ts:
// honour the recorded capture config, refuse to replay when it cannot be
// satisfied rather than silently changing the answer.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { CliError, EXIT_CODES } from "./exit-codes.js";

export const FIXTURE_FORMAT = "syrinx.fixture.v1";

export interface FixtureSidecar {
  readonly format: string;
  readonly turnId?: string;
  readonly expectedTranscript?: string;
  readonly agentText?: string;
  readonly audioFile: string;
  readonly audio: { readonly sampleRateHz: number; readonly channels: number; readonly encoding: string };
  readonly capture?: { readonly inputSampleRateHz?: number };
}

export interface LoadedFixture {
  readonly sidecarPath: string;
  readonly sidecar: FixtureSidecar;
  /** The paired WAV file this fixture replays — prefers the sibling "captured.wav" the Studio actually wrote. */
  readonly wavPath: string;
}

/**
 * Parse and validate a fixture sidecar JSON file, refusing (CliError, USAGE) on
 * anything this CLI cannot honestly replay: an unrecognised format, or capture
 * conditions (sample rate / channel count) that would silently change the
 * transcript if replayed as-is.
 */
export function loadFixture(sidecarPath: string): LoadedFixture {
  let raw: string;
  try {
    raw = readFileSync(sidecarPath, "utf8");
  } catch (err) {
    throw new CliError(EXIT_CODES.USAGE, `fixture not found: ${sidecarPath}`, { cause: String(err) });
  }

  let sidecar: FixtureSidecar;
  try {
    sidecar = JSON.parse(raw) as FixtureSidecar;
  } catch (err) {
    throw new CliError(EXIT_CODES.USAGE, `fixture is not valid JSON: ${sidecarPath}`, { cause: String(err) });
  }

  if (sidecar.format !== FIXTURE_FORMAT) {
    throw new CliError(EXIT_CODES.USAGE, `unsupported fixture format "${sidecar.format}" (expected "${FIXTURE_FORMAT}")`);
  }
  // The sidecar exists so replay conditions can be checked rather than assumed —
  // replaying 24 kHz audio against a 16 kHz-mono expectation changes the transcript.
  if (sidecar.audio.sampleRateHz !== 16000 || sidecar.audio.channels !== 1) {
    throw new CliError(
      EXIT_CODES.USAGE,
      `this replay path needs mono 16 kHz audio; fixture is ${String(sidecar.audio.channels)}ch @ ${String(sidecar.audio.sampleRateHz)} Hz`,
    );
  }

  const dir = dirname(sidecarPath);
  const sibling = join(dir, "captured.wav");
  let wavPath: string;
  try {
    readFileSync(sibling);
    wavPath = sibling;
  } catch {
    wavPath = join(dir, sidecar.audioFile);
  }

  return { sidecarPath, sidecar, wavPath };
}

/** Compare on words, not punctuation — STT capitalises and punctuates inconsistently. */
export function normalizeTranscript(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

export interface TranscriptAssertion {
  readonly expectedTranscript: string;
  readonly actualTranscript: string;
  readonly match: boolean;
}

export function assertTranscript(expectedTranscript: string, actualTranscript: string): TranscriptAssertion {
  return {
    expectedTranscript,
    actualTranscript,
    match: normalizeTranscript(expectedTranscript) === normalizeTranscript(actualTranscript),
  };
}
