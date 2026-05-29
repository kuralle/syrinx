// SPDX-License-Identifier: MIT

import { writeFile } from "node:fs/promises";

export interface SmokeArtifactManifest {
  readonly schemaVersion: 2;
  readonly scenario: string;
  readonly generatedAt: string;
  readonly transport: "websocket" | "twilio_media_stream_websocket" | "telnyx_media_stream_websocket" | "smartpbx_media_stream_websocket";
  readonly fixtureProvider: string;
  readonly run: {
    readonly runDir: string;
    readonly baselinePath?: string;
  };
  readonly audio: {
    readonly inputSampleRateHz: number;
    readonly outputSampleRateHz: number;
    readonly inputByteLength: number;
    readonly outputByteLength: number;
    readonly inputWireByteLength?: number;
    readonly outputWireByteLength?: number;
    readonly inputDecodedPcmByteLength?: number;
    readonly outputDecodedPcmByteLength?: number;
    readonly inputDurationMs: number;
    readonly outputDurationMs: number;
  };
  readonly turns: readonly SmokeTurnArtifact[];
  readonly qualityGate: {
    readonly passed: boolean;
    readonly failures: readonly string[];
  };
}

export interface SmokeTurnArtifact {
  readonly id: string;
  readonly fixtureId: string;
  readonly inputAudio: SmokeAudioArtifact;
  readonly assistantAudio: SmokeAudioArtifact;
  readonly latencyMs: Record<string, number>;
}

export interface SmokeAudioArtifact {
  readonly sampleRateHz: number;
  readonly encoding: "pcm_s16le" | "pcmu" | "opus";
  readonly channels: 1;
  readonly byteLength: number;
  readonly wireByteLength?: number;
  readonly decodedPcmByteLength?: number;
  readonly frameCount?: number;
  readonly durationMs: number;
  readonly path?: string;
}

export async function writeSmokeArtifactManifest(path: string, manifest: SmokeArtifactManifest): Promise<void> {
  assertSmokeArtifactManifest(manifest);
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function pcm16DurationMs(byteLength: number, sampleRateHz: number): number {
  if (sampleRateHz <= 0) return 0;
  return Math.round((byteLength / 2 / sampleRateHz) * 1000);
}

export function pcMuDurationMs(byteLength: number, sampleRateHz: number): number {
  if (sampleRateHz <= 0) return 0;
  return Math.round((byteLength / sampleRateHz) * 1000);
}

export function assertSmokeArtifactManifest(manifest: SmokeArtifactManifest): void {
  const failures = validateSmokeArtifactManifest(manifest);
  if (failures.length > 0) {
    throw new Error(`Invalid smoke artifact manifest: ${failures.join("; ")}`);
  }
}

export function validateSmokeArtifactManifest(manifest: SmokeArtifactManifest): string[] {
  const failures: string[] = [];
  if (manifest.schemaVersion !== 2) failures.push(`expected schemaVersion 2, got ${String(manifest.schemaVersion)}`);
  if (manifest.turns.length === 0) failures.push("expected at least one turn");
  validateQualityGate(manifest, failures);
  validateAudioTotals(manifest, failures);
  for (const turn of manifest.turns) {
    validateAudioArtifact(`turn ${turn.id} inputAudio`, turn.inputAudio, failures);
    validateAudioArtifact(`turn ${turn.id} assistantAudio`, turn.assistantAudio, failures);
    validatePassedAudioEvidence(manifest, turn, failures);
    validateLatencyArtifact(manifest.transport, turn, failures);
    for (const [name, value] of Object.entries(turn.latencyMs)) {
      if (!isNonNegativeFiniteNumber(value)) failures.push(`turn ${turn.id} latency ${name} must be a non-negative finite number`);
    }
  }
  return failures;
}

function validateQualityGate(manifest: SmokeArtifactManifest, failures: string[]): void {
  if (manifest.qualityGate.passed && manifest.qualityGate.failures.length > 0) {
    failures.push("qualityGate.passed cannot be true when qualityGate.failures is non-empty");
  }
  if (!manifest.qualityGate.passed && manifest.qualityGate.failures.length === 0) {
    failures.push("qualityGate.failures must explain a failed quality gate");
  }
}

function validatePassedAudioEvidence(
  manifest: SmokeArtifactManifest,
  turn: SmokeTurnArtifact,
  failures: string[],
): void {
  if (!manifest.qualityGate.passed) return;
  if (effectiveDecodedPcmByteLength(turn.inputAudio) === 0) {
    failures.push(`turn ${turn.id} inputAudio must contain decoded PCM evidence when qualityGate.passed is true`);
  }
  if (effectiveDecodedPcmByteLength(turn.assistantAudio) === 0) {
    failures.push(`turn ${turn.id} assistantAudio must contain decoded PCM evidence when qualityGate.passed is true`);
  }
}

function validateLatencyArtifact(
  transport: SmokeArtifactManifest["transport"],
  turn: SmokeTurnArtifact,
  failures: string[],
): void {
  if (transport === "websocket") return;
  for (const name of TELEPHONY_REQUIRED_LATENCY_FIELDS) {
    if (!(name in turn.latencyMs)) failures.push(`turn ${turn.id} latency ${name} is required for ${transport}`);
  }
}

function validateAudioTotals(manifest: SmokeArtifactManifest, failures: string[]): void {
  const inputByteLength = sum(manifest.turns.map((turn) => turn.inputAudio.byteLength));
  const outputByteLength = sum(manifest.turns.map((turn) => turn.assistantAudio.byteLength));
  const inputDurationMs = sum(manifest.turns.map((turn) => turn.inputAudio.durationMs));
  const outputDurationMs = sum(manifest.turns.map((turn) => turn.assistantAudio.durationMs));
  if (manifest.audio.inputByteLength !== inputByteLength) {
    failures.push(`audio.inputByteLength ${String(manifest.audio.inputByteLength)} did not match turn total ${String(inputByteLength)}`);
  }
  if (manifest.audio.outputByteLength !== outputByteLength) {
    failures.push(`audio.outputByteLength ${String(manifest.audio.outputByteLength)} did not match turn total ${String(outputByteLength)}`);
  }
  if (!withinRoundingTolerance(manifest.audio.inputDurationMs, inputDurationMs, manifest.turns.length)) {
    failures.push(`audio.inputDurationMs ${String(manifest.audio.inputDurationMs)} did not match turn total ${String(inputDurationMs)}`);
  }
  if (!withinRoundingTolerance(manifest.audio.outputDurationMs, outputDurationMs, manifest.turns.length)) {
    failures.push(`audio.outputDurationMs ${String(manifest.audio.outputDurationMs)} did not match turn total ${String(outputDurationMs)}`);
  }
  validateOptionalTotal("audio.inputWireByteLength", manifest.audio.inputWireByteLength, manifest.turns.map((turn) => effectiveWireByteLength(turn.inputAudio)), failures);
  validateOptionalTotal("audio.outputWireByteLength", manifest.audio.outputWireByteLength, manifest.turns.map((turn) => effectiveWireByteLength(turn.assistantAudio)), failures);
  validateOptionalTotal(
    "audio.inputDecodedPcmByteLength",
    manifest.audio.inputDecodedPcmByteLength,
    manifest.turns.map((turn) => effectiveDecodedPcmByteLength(turn.inputAudio)),
    failures,
  );
  validateOptionalTotal(
    "audio.outputDecodedPcmByteLength",
    manifest.audio.outputDecodedPcmByteLength,
    manifest.turns.map((turn) => effectiveDecodedPcmByteLength(turn.assistantAudio)),
    failures,
  );
}

function validateOptionalTotal(name: string, actual: number | undefined, values: readonly number[], failures: string[]): void {
  if (actual === undefined) return;
  const expected = sum(values);
  if (actual !== expected) failures.push(`${name} ${String(actual)} did not match turn total ${String(expected)}`);
}

function validateAudioArtifact(label: string, artifact: SmokeAudioArtifact, failures: string[]): void {
  if (!isPositiveInteger(artifact.sampleRateHz)) failures.push(`${label}.sampleRateHz must be a positive integer`);
  if (!isSupportedEncoding(artifact.encoding)) failures.push(`${label}.encoding must be pcm_s16le, pcmu, or opus`);
  if (artifact.channels !== 1) failures.push(`${label}.channels must be 1`);
  if (!isNonNegativeInteger(artifact.byteLength)) failures.push(`${label}.byteLength must be a non-negative integer`);
  if (!isNonNegativeInteger(artifact.durationMs)) failures.push(`${label}.durationMs must be a non-negative integer`);
  if (artifact.wireByteLength !== undefined && !isNonNegativeInteger(artifact.wireByteLength)) {
    failures.push(`${label}.wireByteLength must be a non-negative integer`);
  }
  if (artifact.decodedPcmByteLength !== undefined && !isNonNegativeInteger(artifact.decodedPcmByteLength)) {
    failures.push(`${label}.decodedPcmByteLength must be a non-negative integer`);
  }
  if (artifact.frameCount !== undefined && !isNonNegativeInteger(artifact.frameCount)) {
    failures.push(`${label}.frameCount must be a non-negative integer`);
  }

  if (artifact.encoding === "pcm_s16le" && artifact.byteLength % 2 !== 0) {
    failures.push(`${label}.byteLength must contain an even number of PCM16 bytes`);
  }
  if (artifact.decodedPcmByteLength !== undefined && artifact.decodedPcmByteLength % 2 !== 0) {
    failures.push(`${label}.decodedPcmByteLength must contain an even number of PCM16 bytes`);
  }

  if (isCompressedEncoding(artifact.encoding) && artifact.wireByteLength === undefined) {
    failures.push(`${label}.wireByteLength is required for ${encodingLabel(artifact.encoding)} audio`);
  }
  if (isCompressedEncoding(artifact.encoding) && artifact.decodedPcmByteLength === undefined) {
    failures.push(`${label}.decodedPcmByteLength is required for ${encodingLabel(artifact.encoding)} audio`);
  }

  const expectedDuration = expectedAudioDurationMs(artifact);
  if (expectedDuration !== artifact.durationMs) {
    failures.push(`${label}.durationMs ${String(artifact.durationMs)} did not match ${String(expectedDuration)} from byte count/sample rate`);
  }
}

function expectedAudioDurationMs(artifact: SmokeAudioArtifact): number {
  if (artifact.encoding === "pcmu") return pcMuDurationMs(effectiveWireByteLength(artifact), artifact.sampleRateHz);
  return pcm16DurationMs(effectiveDecodedPcmByteLength(artifact), artifact.sampleRateHz);
}

function effectiveWireByteLength(artifact: SmokeAudioArtifact): number {
  return artifact.wireByteLength ?? artifact.byteLength;
}

function effectiveDecodedPcmByteLength(artifact: SmokeAudioArtifact): number {
  return artifact.decodedPcmByteLength ?? artifact.byteLength;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function isNonNegativeFiniteNumber(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function isSupportedEncoding(value: unknown): value is SmokeAudioArtifact["encoding"] {
  return value === "pcm_s16le" || value === "pcmu" || value === "opus";
}

function isCompressedEncoding(value: unknown): value is "pcmu" | "opus" {
  return value === "pcmu" || value === "opus";
}

function encodingLabel(encoding: "pcmu" | "opus"): string {
  return encoding === "pcmu" ? "PCMU" : "Opus";
}

function withinRoundingTolerance(actual: number, expected: number, count: number): boolean {
  return Math.abs(actual - expected) <= Math.max(1, count);
}

const TELEPHONY_REQUIRED_LATENCY_FIELDS = [
  "firstInboundMediaAfterStart",
  "lastInboundMediaAfterStart",
  "maxInboundMediaGap",
  "firstOutboundMediaAfterStart",
  "firstOutboundMediaAfterFirstInbound",
  "firstOutboundMediaAfterLastInbound",
] as const;
