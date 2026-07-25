// SPDX-License-Identifier: MIT
//
// Turn a captured turn into a fixture: a WAV plus a JSON sidecar.
//
// This is the point of the whole studio. Hearing the agent misbehave is worth
// nothing if the moment evaporates; a fixture is that moment made repeatable.
//
// The sidecar carries the capture config, not just the expected transcript,
// because a fixture replayed under different conditions lies. Replay 24 kHz audio
// against a 16 kHz expectation and the transcript changes — and you blame the
// agent for a change you introduced. So the conditions travel with the audio.

import type { SessionConfig, TurnRecord } from "@kuralle-syrinx/browser-client/record";

/** Schema version. Written so a replayer can refuse a fixture it does not understand. */
export const FIXTURE_FORMAT = "syrinx.fixture.v1";

export interface FixtureSidecar {
  readonly format: typeof FIXTURE_FORMAT;
  readonly turnId: string;
  /** What the agent heard. The assertion a replay checks against. */
  readonly expectedTranscript?: string;
  /** What the agent said back. Recorded for context; replays vary here legitimately. */
  readonly agentText?: string;
  readonly capturedAtIso: string;
  readonly audioFile: string;
  readonly audio: {
    readonly sampleRateHz: number;
    readonly channels: 1;
    readonly encoding: "pcm_s16le";
    readonly durationMs: number;
    /** True when the recorder hit its per-turn ceiling and dropped the tail. */
    readonly truncated: boolean;
  };
  /**
   * The session this was captured under. Every field here can change the
   * transcript on replay, which is why none of them is inferred at replay time.
   */
  readonly capture: {
    readonly wsUrl?: string;
    readonly inputSampleRateHz?: number;
    readonly outputSampleRateHz?: number;
    readonly encoding?: string;
    readonly endpointingOwner?: string;
    readonly targetFrameDurationMs?: number;
  };
  /** Present only when the turn carried them; absent, never zeroed. */
  readonly observedTimings?: TurnRecord["timings"];
}

export interface FixtureFiles {
  readonly baseName: string;
  readonly wavFileName: string;
  readonly jsonFileName: string;
  readonly wav: Uint8Array;
  readonly json: string;
  readonly sidecar: FixtureSidecar;
}

/**
 * A filename derived from what the user actually said, so a folder of fixtures is
 * readable at a glance rather than a wall of turn ids.
 */
export function fixtureBaseName(turn: TurnRecord, capturedAtIso: string): string {
  const slug = (turn.userTranscript ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 8)
    .join("-");
  const stamp = capturedAtIso.replace(/[:.]/g, "-").replace(/T/, "_").slice(0, 19);
  return slug === "" ? `turn-${turn.turnId}-${stamp}` : `${slug}-${stamp}`;
}

export interface BuildFixtureInput {
  readonly turn: TurnRecord;
  readonly config: SessionConfig;
  readonly wav: Uint8Array;
  readonly sampleRateHz: number;
  readonly durationMs: number;
  readonly truncated: boolean;
  readonly capturedAtIso: string;
}

/**
 * Assemble the two files. Pure — no DOM, no download — so the format is testable
 * without a browser and a replayer can be written against it directly.
 */
export function buildFixture(input: BuildFixtureInput): FixtureFiles {
  const { turn, config, wav, sampleRateHz, durationMs, truncated, capturedAtIso } = input;
  const baseName = fixtureBaseName(turn, capturedAtIso);
  const wavFileName = `${baseName}.wav`;

  const sidecar: FixtureSidecar = {
    format: FIXTURE_FORMAT,
    turnId: turn.turnId,
    ...(turn.userTranscript !== undefined ? { expectedTranscript: turn.userTranscript } : {}),
    ...(turn.agentText !== "" ? { agentText: turn.agentText } : {}),
    capturedAtIso,
    audioFile: wavFileName,
    audio: { sampleRateHz, channels: 1, encoding: "pcm_s16le", durationMs, truncated },
    capture: {
      ...(config.wsUrl !== undefined ? { wsUrl: config.wsUrl } : {}),
      ...(config.inputSampleRateHz !== undefined ? { inputSampleRateHz: config.inputSampleRateHz } : {}),
      ...(config.outputSampleRateHz !== undefined ? { outputSampleRateHz: config.outputSampleRateHz } : {}),
      ...(config.encoding !== undefined ? { encoding: config.encoding } : {}),
      ...(config.endpointingOwner !== undefined ? { endpointingOwner: config.endpointingOwner } : {}),
      ...(config.targetFrameDurationMs !== undefined
        ? { targetFrameDurationMs: config.targetFrameDurationMs }
        : {}),
    },
    ...(turn.timings !== undefined ? { observedTimings: turn.timings } : {}),
  };

  return {
    baseName,
    wavFileName,
    jsonFileName: `${baseName}.json`,
    wav,
    json: `${JSON.stringify(sidecar, null, 2)}\n`,
    sidecar,
  };
}

/**
 * Why a turn cannot be saved, in words, or undefined when it can.
 *
 * Returned rather than thrown so the button can explain itself before being
 * pressed — a disabled control with no reason is its own bug.
 */
export function fixtureBlockedReason(
  turn: TurnRecord,
  hasAudio: boolean,
): string | undefined {
  if (!hasAudio) {
    return "No recorded audio for this turn — typed turns have none, and the oldest turns' audio is dropped to bound memory.";
  }
  if (turn.userTranscript === undefined) {
    return "This turn was never transcribed, so there is nothing for a replay to assert against.";
  }
  return undefined;
}
