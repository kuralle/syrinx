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

export function assertSmokeArtifactManifest(manifest: unknown): asserts manifest is SmokeArtifactManifest {
  const failures = validateSmokeArtifactManifest(manifest);
  if (failures.length > 0) {
    throw new Error(`Invalid smoke artifact manifest: ${failures.join("; ")}`);
  }
}

export function validateSmokeArtifactManifest(manifest: unknown): string[] {
  const failures: string[] = [];
  if (!isRecord(manifest)) return ["manifest must be an object"];

  if (manifest["schemaVersion"] !== 2) failures.push(`expected schemaVersion 2, got ${String(manifest["schemaVersion"])}`);
  const transport = manifest["transport"];
  if (!isSupportedTransport(transport)) failures.push("transport must be websocket, twilio_media_stream_websocket, telnyx_media_stream_websocket, or smartpbx_media_stream_websocket");

  const qualityGate = manifest["qualityGate"];
  validateQualityGate(qualityGate, failures);

  const turns = manifest["turns"];
  if (!Array.isArray(turns)) {
    failures.push("turns must be an array");
  } else if (turns.length === 0) {
    failures.push("expected at least one turn");
  }

  const validTurns: SmokeTurnArtifact[] = [];
  if (Array.isArray(turns)) {
    for (const [index, turn] of turns.entries()) {
      const validatedTurn = validateTurnArtifact(turn, index, transport, qualityGate, failures);
      if (validatedTurn) validTurns.push(validatedTurn);
    }
  }

  const audio = manifest["audio"];
  if (!isRecord(audio)) {
    failures.push("audio must be an object");
  } else if (validTurns.length === (Array.isArray(turns) ? turns.length : -1)) {
    validateAudioTotals(audio, validTurns, failures);
  }
  return failures;
}

function validateQualityGate(qualityGate: unknown, failures: string[]): void {
  if (!isRecord(qualityGate)) {
    failures.push("qualityGate must be an object");
    return;
  }
  const gateFailures = qualityGate["failures"];
  if (typeof qualityGate["passed"] !== "boolean") failures.push("qualityGate.passed must be a boolean");
  if (!Array.isArray(gateFailures)) {
    failures.push("qualityGate.failures must be an array");
    return;
  }
  if (!gateFailures.every((failure) => typeof failure === "string")) {
    failures.push("qualityGate.failures must contain only strings");
  }
  if (qualityGate["passed"] === true && gateFailures.length > 0) {
    failures.push("qualityGate.passed cannot be true when qualityGate.failures is non-empty");
  }
  if (qualityGate["passed"] === false && gateFailures.length === 0) {
    failures.push("qualityGate.failures must explain a failed quality gate");
  }
}

function validateTurnArtifact(
  turn: unknown,
  index: number,
  transport: unknown,
  qualityGate: unknown,
  failures: string[],
): SmokeTurnArtifact | null {
  if (!isRecord(turn)) {
    failures.push(`turn ${String(index)} must be an object`);
    return null;
  }
  const id = typeof turn["id"] === "string" && turn["id"].length > 0 ? turn["id"] : String(index);
  if (typeof turn["id"] !== "string" || turn["id"].length === 0) failures.push(`turn ${id}.id must be a non-empty string`);
  if (typeof turn["fixtureId"] !== "string" || turn["fixtureId"].length === 0) failures.push(`turn ${id}.fixtureId must be a non-empty string`);

  validateAudioArtifact(`turn ${id} inputAudio`, turn["inputAudio"], failures);
  validateAudioArtifact(`turn ${id} assistantAudio`, turn["assistantAudio"], failures);

  const latencyMs = turn["latencyMs"];
  if (!isRecord(latencyMs)) {
    failures.push(`turn ${id}.latencyMs must be an object`);
  } else {
    validateLatencyArtifact(transport, id, latencyMs, failures);
    for (const [name, value] of Object.entries(latencyMs)) {
      if (!isNonNegativeFiniteNumber(value)) failures.push(`turn ${id} latency ${name} must be a non-negative finite number`);
    }
  }

  if (
    isValidAudioArtifactForTotals(turn["inputAudio"]) &&
    isValidAudioArtifactForTotals(turn["assistantAudio"]) &&
    isRecord(latencyMs)
  ) {
    const validatedTurn = {
      id,
      fixtureId: String(turn["fixtureId"] ?? ""),
      inputAudio: turn["inputAudio"],
      assistantAudio: turn["assistantAudio"],
      latencyMs: latencyMs as Record<string, number>,
    };
    validatePassedAudioEvidence(qualityGate, validatedTurn, failures);
    return validatedTurn;
  }

  return null;
}

function validatePassedAudioEvidence(
  qualityGate: unknown,
  turn: SmokeTurnArtifact,
  failures: string[],
): void {
  if (!isRecord(qualityGate) || qualityGate["passed"] !== true) return;
  if (effectiveDecodedPcmByteLength(turn.inputAudio) === 0) {
    failures.push(`turn ${turn.id} inputAudio must contain decoded PCM evidence when qualityGate.passed is true`);
  }
  if (effectiveDecodedPcmByteLength(turn.assistantAudio) === 0) {
    failures.push(`turn ${turn.id} assistantAudio must contain decoded PCM evidence when qualityGate.passed is true`);
  }
}

function validateLatencyArtifact(
  transport: unknown,
  turnId: string,
  latencyMs: Record<string, unknown>,
  failures: string[],
): void {
  if (transport === "websocket") return;
  if (!isSupportedTransport(transport)) return;
  for (const name of TELEPHONY_REQUIRED_LATENCY_FIELDS) {
    if (!(name in latencyMs)) failures.push(`turn ${turnId} latency ${name} is required for ${transport}`);
  }
}

function validateAudioTotals(audio: Record<string, unknown>, turns: readonly SmokeTurnArtifact[], failures: string[]): void {
  const inputByteLength = sum(turns.map((turn) => turn.inputAudio.byteLength));
  const outputByteLength = sum(turns.map((turn) => turn.assistantAudio.byteLength));
  const inputDurationMs = sum(turns.map((turn) => turn.inputAudio.durationMs));
  const outputDurationMs = sum(turns.map((turn) => turn.assistantAudio.durationMs));
  if (audio["inputByteLength"] !== inputByteLength) {
    failures.push(`audio.inputByteLength ${String(audio["inputByteLength"])} did not match turn total ${String(inputByteLength)}`);
  }
  if (audio["outputByteLength"] !== outputByteLength) {
    failures.push(`audio.outputByteLength ${String(audio["outputByteLength"])} did not match turn total ${String(outputByteLength)}`);
  }
  if (!withinRoundingTolerance(audio["inputDurationMs"], inputDurationMs, turns.length)) {
    failures.push(`audio.inputDurationMs ${String(audio["inputDurationMs"])} did not match turn total ${String(inputDurationMs)}`);
  }
  if (!withinRoundingTolerance(audio["outputDurationMs"], outputDurationMs, turns.length)) {
    failures.push(`audio.outputDurationMs ${String(audio["outputDurationMs"])} did not match turn total ${String(outputDurationMs)}`);
  }
  validateOptionalTotal("audio.inputWireByteLength", audio["inputWireByteLength"], turns.map((turn) => effectiveWireByteLength(turn.inputAudio)), failures);
  validateOptionalTotal("audio.outputWireByteLength", audio["outputWireByteLength"], turns.map((turn) => effectiveWireByteLength(turn.assistantAudio)), failures);
  validateOptionalTotal(
    "audio.inputDecodedPcmByteLength",
    audio["inputDecodedPcmByteLength"],
    turns.map((turn) => effectiveDecodedPcmByteLength(turn.inputAudio)),
    failures,
  );
  validateOptionalTotal(
    "audio.outputDecodedPcmByteLength",
    audio["outputDecodedPcmByteLength"],
    turns.map((turn) => effectiveDecodedPcmByteLength(turn.assistantAudio)),
    failures,
  );
}

function validateOptionalTotal(name: string, actual: unknown, values: readonly number[], failures: string[]): void {
  if (actual === undefined) return;
  const expected = sum(values);
  if (actual !== expected) failures.push(`${name} ${String(actual)} did not match turn total ${String(expected)}`);
}

function validateAudioArtifact(label: string, artifact: unknown, failures: string[]): void {
  if (!isRecord(artifact)) {
    failures.push(`${label} must be an object`);
    return;
  }
  if (!isPositiveInteger(artifact["sampleRateHz"])) failures.push(`${label}.sampleRateHz must be a positive integer`);
  if (!isSupportedEncoding(artifact["encoding"])) failures.push(`${label}.encoding must be pcm_s16le, pcmu, or opus`);
  if (artifact["channels"] !== 1) failures.push(`${label}.channels must be 1`);
  if (!isNonNegativeInteger(artifact["byteLength"])) failures.push(`${label}.byteLength must be a non-negative integer`);
  if (!isNonNegativeInteger(artifact["durationMs"])) failures.push(`${label}.durationMs must be a non-negative integer`);
  if (artifact["wireByteLength"] !== undefined && !isNonNegativeInteger(artifact["wireByteLength"])) {
    failures.push(`${label}.wireByteLength must be a non-negative integer`);
  }
  if (artifact["decodedPcmByteLength"] !== undefined && !isNonNegativeInteger(artifact["decodedPcmByteLength"])) {
    failures.push(`${label}.decodedPcmByteLength must be a non-negative integer`);
  }
  if (artifact["frameCount"] !== undefined && !isNonNegativeInteger(artifact["frameCount"])) {
    failures.push(`${label}.frameCount must be a non-negative integer`);
  }

  if (artifact["encoding"] === "pcm_s16le" && typeof artifact["byteLength"] === "number" && artifact["byteLength"] % 2 !== 0) {
    failures.push(`${label}.byteLength must contain an even number of PCM16 bytes`);
  }
  if (typeof artifact["decodedPcmByteLength"] === "number" && artifact["decodedPcmByteLength"] % 2 !== 0) {
    failures.push(`${label}.decodedPcmByteLength must contain an even number of PCM16 bytes`);
  }

  if (isCompressedEncoding(artifact["encoding"]) && artifact["wireByteLength"] === undefined) {
    failures.push(`${label}.wireByteLength is required for ${encodingLabel(artifact["encoding"])} audio`);
  }
  if (isCompressedEncoding(artifact["encoding"]) && artifact["decodedPcmByteLength"] === undefined) {
    failures.push(`${label}.decodedPcmByteLength is required for ${encodingLabel(artifact["encoding"])} audio`);
  }

  if (
    isSupportedEncoding(artifact["encoding"]) &&
    isPositiveInteger(artifact["sampleRateHz"]) &&
    isNonNegativeInteger(artifact["byteLength"]) &&
    isNonNegativeInteger(artifact["durationMs"]) &&
    (artifact["decodedPcmByteLength"] === undefined || isNonNegativeInteger(artifact["decodedPcmByteLength"])) &&
    (artifact["wireByteLength"] === undefined || isNonNegativeInteger(artifact["wireByteLength"]))
  ) {
    const expectedDuration = expectedAudioDurationMs(artifact as unknown as SmokeAudioArtifact);
    if (expectedDuration !== artifact["durationMs"]) {
      failures.push(`${label}.durationMs ${String(artifact["durationMs"])} did not match ${String(expectedDuration)} from byte count/sample rate`);
    }
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

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isSupportedEncoding(value: unknown): value is SmokeAudioArtifact["encoding"] {
  return value === "pcm_s16le" || value === "pcmu" || value === "opus";
}

function isCompressedEncoding(value: unknown): value is "pcmu" | "opus" {
  return value === "pcmu" || value === "opus";
}

function isSupportedTransport(value: unknown): value is SmokeArtifactManifest["transport"] {
  return value === "websocket" ||
    value === "twilio_media_stream_websocket" ||
    value === "telnyx_media_stream_websocket" ||
    value === "smartpbx_media_stream_websocket";
}

function isValidAudioArtifactForTotals(value: unknown): value is SmokeAudioArtifact {
  if (!isRecord(value)) return false;
  return isPositiveInteger(value["sampleRateHz"]) &&
    isSupportedEncoding(value["encoding"]) &&
    value["channels"] === 1 &&
    isNonNegativeInteger(value["byteLength"]) &&
    isNonNegativeInteger(value["durationMs"]) &&
    (value["wireByteLength"] === undefined || isNonNegativeInteger(value["wireByteLength"])) &&
    (value["decodedPcmByteLength"] === undefined || isNonNegativeInteger(value["decodedPcmByteLength"])) &&
    (value["frameCount"] === undefined || isNonNegativeInteger(value["frameCount"]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodingLabel(encoding: "pcmu" | "opus"): string {
  return encoding === "pcmu" ? "PCMU" : "Opus";
}

function withinRoundingTolerance(actual: unknown, expected: number, count: number): boolean {
  if (typeof actual !== "number") return false;
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
