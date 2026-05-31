// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateVoiceSessionRecorderManifest, type VoiceSessionRecorderManifest } from "@asyncdot/voice-recorder";

import { ensureRepoRootDotenv } from "../src/run-one-turn.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const REPO_ROOT = join(PKG_ROOT, "..", "..");
const RUNS_DIR = join(PKG_ROOT, "test", "performance", "runs");
const DEFAULT_REGION = "sin";
const DEFAULT_MEMORY_MB = 1024;
const DEFAULT_PROVIDERS = ["twilio", "telnyx", "smartpbx"] as const;

type Provider = typeof DEFAULT_PROVIDERS[number];

interface ArtifactIndex {
  readonly recordingDir?: string;
  readonly artifacts?: Array<{ readonly path?: string; readonly url?: string; readonly source?: string }>;
}

export interface FlySpikeSummary {
  readonly scenario: "fly_synthetic_public_carrier_to_bot";
  readonly generatedAt: string;
  readonly region: string;
  readonly memoryMb: number;
  readonly networkProfile: string;
  readonly apps: {
    readonly bot: string;
    readonly carrier: string;
  };
  readonly urls: {
    readonly botBaseUrl: string;
    readonly carrierBaseUrl: string;
  };
  providers: Array<Record<string, unknown>>;
  readonly artifacts: {
    readonly runDir: string;
    readonly summaryPath: string;
  };
  cleanup: {
    botDestroyed: boolean;
    carrierDestroyed: boolean;
  };
}

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  const generatedAt = new Date().toISOString();
  const runId = generatedAt.replaceAll(":", "-").replaceAll(".", "-");
  const suffix = readSuffix(generatedAt);
  const region = process.env["SYRINX_FLY_REGION"]?.trim() || DEFAULT_REGION;
  const memoryMb = readPositiveIntegerEnv("SYRINX_FLY_MEMORY_MB", DEFAULT_MEMORY_MB);
  const networkProfile = process.env["SYRINX_TELEPHONY_NETWORK_PROFILE"]?.trim() || "jittery";
  const providers = readProviders();
  const botApp = process.env["SYRINX_FLY_BOT_APP"]?.trim() || `syrinx-bot-spike-${suffix}`;
  const carrierApp = process.env["SYRINX_FLY_CARRIER_APP"]?.trim() || `syrinx-carrier-spike-${suffix}`;
  const botBaseUrl = `https://${botApp}.fly.dev`;
  const carrierBaseUrl = `https://${carrierApp}.fly.dev`;
  const runDir = join(RUNS_DIR, `fly-synthetic-carrier-${runId}`);
  const localBotArtifactsDir = join(runDir, "bot-artifacts");
  const localCarrierArtifactsDir = join(runDir, "carrier-artifacts");
  const configDir = join(runDir, "fly");
  await mkdir(configDir, { recursive: true });
  await mkdir(localBotArtifactsDir, { recursive: true });
  await mkdir(localCarrierArtifactsDir, { recursive: true });

  const botConfigPath = join(configDir, "bot.toml");
  const carrierConfigPath = join(configDir, "carrier.toml");
  await Promise.all([
    writeFile(botConfigPath, renderBotFlyToml(botApp, region, memoryMb, botBaseUrl), "utf8"),
    writeFile(carrierConfigPath, renderCarrierFlyToml(carrierApp, region, memoryMb, botBaseUrl, networkProfile), "utf8"),
  ]);

  const summary: FlySpikeSummary = {
    scenario: "fly_synthetic_public_carrier_to_bot",
    generatedAt,
    region,
    memoryMb,
    networkProfile,
    apps: { bot: botApp, carrier: carrierApp },
    urls: { botBaseUrl, carrierBaseUrl },
    providers: [],
    artifacts: {
      runDir: relative(PKG_ROOT, runDir),
      summaryPath: relative(PKG_ROOT, join(runDir, "summary.json")),
    },
    cleanup: {
      botDestroyed: false,
      carrierDestroyed: false,
    },
  };

  try {
    await run("fly", ["config", "validate", "-c", botConfigPath]);
    await run("fly", ["config", "validate", "-c", carrierConfigPath]);
    await createFlyApp(botApp);
    await createFlyApp(carrierApp);
    await importBotSecrets(botApp);
    await run("fly", ["deploy", "-c", botConfigPath, "--dockerfile", "Dockerfile.telephony-spike", "--ha=false", "--wait-timeout", "10m"]);
    await waitForOkJson(`${botBaseUrl}/healthz`, 180_000);
    await run("fly", ["deploy", "-c", carrierConfigPath, "--dockerfile", "Dockerfile.telephony-spike", "--ha=false", "--wait-timeout", "10m"]);
    await waitForOkJson(`${carrierBaseUrl}/healthz`, 180_000);

    let knownBotArtifacts = await readBotArtifactPaths(botBaseUrl);
    for (const provider of providers) {
      const callResult = await runSyntheticCall(carrierBaseUrl, provider, networkProfile);
      const afterArtifacts = await readBotArtifactPaths(botBaseUrl);
      const newBotArtifacts = afterArtifacts.filter((artifact) => !knownBotArtifacts.some((seen) => seen.path === artifact.path));
      knownBotArtifacts = afterArtifacts;
      const providerBotDir = join(localBotArtifactsDir, provider);
      const providerCarrierDir = join(localCarrierArtifactsDir, provider);
      await mkdir(providerBotDir, { recursive: true });
      await mkdir(providerCarrierDir, { recursive: true });
      const downloadedBotArtifacts = await downloadBotArtifacts(botBaseUrl, newBotArtifacts, providerBotDir);
      const downloadedCarrierArtifacts = await downloadCarrierArtifacts(carrierBaseUrl, callResult, providerCarrierDir);
      const providerSummary = {
        provider,
        callResult,
        botArtifacts: downloadedBotArtifacts.map((path) => relative(PKG_ROOT, path)),
        carrierArtifacts: downloadedCarrierArtifacts.map((path) => relative(PKG_ROOT, path)),
      };
      summary.providers.push(providerSummary);
      await writeFile(join(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    }
  } finally {
    summary.cleanup.carrierDestroyed = await destroyFlyApp(carrierApp);
    summary.cleanup.botDestroyed = await destroyFlyApp(botApp);
    await writeFile(join(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify(summary, null, 2));
  const failures = await validateDownloadedFlySyntheticCarrierArtifacts(summary, PKG_ROOT);
  if (summary.cleanup.botDestroyed !== true) failures.push(`bot Fly app was not destroyed: ${botApp}`);
  if (summary.cleanup.carrierDestroyed !== true) failures.push(`carrier Fly app was not destroyed: ${carrierApp}`);
  if (failures.length > 0) throw new Error(`Fly synthetic carrier spike failed: ${failures.join("; ")}`);
}

export async function validateDownloadedFlySyntheticCarrierArtifacts(
  summary: FlySpikeSummary,
  pkgRoot = PKG_ROOT,
): Promise<string[]> {
  const failures: string[] = [];
  if (summary.scenario !== "fly_synthetic_public_carrier_to_bot") {
    failures.push(`unexpected Fly synthetic scenario: ${String(summary.scenario)}`);
  }
  if (!Array.isArray(summary.providers) || summary.providers.length === 0) {
    failures.push("summary.providers is empty");
    return failures;
  }

  for (const providerSummary of summary.providers) {
    const provider = providerSummary["provider"];
    if (!isProvider(provider)) {
      failures.push(`unsupported provider in summary: ${String(provider)}`);
      continue;
    }

    const callResult = providerSummary["callResult"];
    if (!isRecord(callResult)) {
      failures.push(`${provider} call result was not an object`);
      continue;
    }
    if (callResult["provider"] !== provider) failures.push(`${provider} call result provider mismatch`);
    validateQualityGate(provider, callResult["qualityGate"], failures);
    validateCarrierCompletionEvidence(provider, callResult, failures);

    const botArtifacts = readStringArray(providerSummary["botArtifacts"]);
    const carrierArtifacts = readStringArray(providerSummary["carrierArtifacts"]);
    const bot = artifactPaths(botArtifacts, pkgRoot);
    const carrier = artifactPaths(carrierArtifacts, pkgRoot);
    const label = (name: string) => `${provider} ${name}`;

    const manifest = await readRecorderManifest(bot.manifestJson, label("bot manifest"), failures);
    const eventPackets = await validateEventsJsonl(bot.eventsJsonl, label("bot events.jsonl"), failures);
    if (manifest) {
      await validatePcmFile(bot.userPcm, label("bot user_audio.pcm"), manifest.audio?.user?.byteLength, failures);
      await validatePcmFile(bot.assistantPcm, label("bot assistant_audio.pcm"), manifest.audio?.assistant?.byteLength, failures);
      await validateWavFile(
        bot.userWav,
        label("bot user_audio.wav"),
        manifest.audio?.user?.sampleRateHz,
        failures,
        manifest.audio?.user?.byteLength,
      );
      await validateWavFile(
        bot.assistantWav,
        label("bot assistant_audio.wav"),
        manifest.audio?.assistant?.sampleRateHz,
        failures,
        manifest.audio?.assistant?.byteLength,
      );
      if (!positiveInteger(manifest.audio?.user?.chunks)) failures.push(`${provider} recorder user chunks must be positive`);
      if (!positiveInteger(manifest.audio?.assistant?.chunks)) {
        failures.push(`${provider} recorder assistant chunks must be positive`);
      }
      if (manifest.audio?.assistant?.truncations !== 0) {
        failures.push(`${provider} recorder assistant truncations expected 0, got ${String(manifest.audio?.assistant?.truncations)}`);
      }
      if (!positiveInteger(manifest.events?.packets)) failures.push(`${provider} recorder event packet count must be positive`);
      if (eventPackets !== null && manifest.events?.packets !== eventPackets) {
        failures.push(
          `${provider} recorder event packet count ${String(eventPackets)} did not match manifest ${String(manifest.events?.packets)}`,
        );
      }
    }

    const downloadedCallResult = await validateCarrierCallResultArtifact(carrier.callResultJson, label("carrier call-result.json"), provider, callResult, failures);
    const downloadedCarrier = isRecord(downloadedCallResult?.["carrier"]) ? downloadedCallResult["carrier"] : null;
    await validateWavFile(carrier.carrierInboundWav, label("carrier-inbound.wav"), 8000, failures, readOptionalPositiveInteger(downloadedCarrier?.["inboundDecodedPcmBytes"]));
    await validateWavFile(carrier.carrierOutboundWav, label("carrier-outbound.wav"), 8000, failures, readOptionalPositiveInteger(downloadedCarrier?.["outboundDecodedPcmBytes"]));
  }

  return failures;
}

async function validateCarrierCallResultArtifact(
  path: string,
  label: string,
  provider: Provider,
  expectedCallResult: Record<string, unknown>,
  failures: string[],
): Promise<Record<string, unknown> | null> {
  const parsed = await validateJsonFile(path, label, failures);
  if (!isRecord(parsed)) return null;
  if (parsed["provider"] !== provider) failures.push(`${label} provider mismatch`);
  validateQualityGate(provider, parsed["qualityGate"], failures);
  validateCarrierCompletionEvidence(provider, parsed, failures);
  if (stableJson(parsed) !== stableJson(expectedCallResult)) {
    failures.push(`${label} did not match summary callResult`);
  }
  return parsed;
}

function validateQualityGate(provider: Provider, qualityGate: unknown, failures: string[]): void {
  if (!isRecord(qualityGate)) {
    failures.push(`${provider} quality gate was missing`);
    return;
  }
  const qualityFailures = Array.isArray(qualityGate["failures"]) ? qualityGate["failures"] : null;
  if (qualityGate["passed"] !== true) failures.push(`${provider} quality gate failed`);
  if (!qualityFailures) {
    failures.push(`${provider} qualityGate.failures must be an array`);
    return;
  }
  const invalidFailure = qualityFailures.find((failure) => typeof failure !== "string");
  if (invalidFailure !== undefined) {
    failures.push(`${provider} qualityGate.failures must contain only strings`);
  }
  if (qualityGate["passed"] === true && qualityFailures.length > 0) {
    failures.push(`${provider} qualityGate.passed cannot be true when qualityGate.failures is non-empty`);
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

function validateCarrierCompletionEvidence(provider: Provider, callResult: Record<string, unknown>, failures: string[]): void {
  const carrier = callResult["carrier"];
  if (!isRecord(carrier)) {
    failures.push(`${provider} carrier result was missing`);
    return;
  }
  for (const field of ["inboundFrames", "outboundFrames", "inboundWireBytes", "outboundWireBytes", "inboundDecodedPcmBytes", "outboundDecodedPcmBytes"]) {
    if (!positiveInteger(carrier[field])) failures.push(`${provider} carrier.${field} must be positive`);
  }
  if (!nonNegativeNumber(carrier["maxInboundMediaGapMs"])) failures.push(`${provider} carrier.maxInboundMediaGapMs is required`);
  if (!positiveInteger(carrier["firstOutboundMediaAfterStartMs"])) {
    failures.push(`${provider} carrier.firstOutboundMediaAfterStartMs must be positive`);
  }
  if (provider === "twilio" || provider === "telnyx") {
    if (!positiveInteger(carrier["outboundEndMarks"])) failures.push(`${provider} requires a terminal outbound end mark`);
  } else if (!positiveInteger(carrier["outboundQuietDrains"]) && !positiveInteger(carrier["localPlayoutDrains"])) {
    failures.push("smartpbx requires a local playout or quiet-drain completion signal");
  }
}

function readOptionalPositiveInteger(value: unknown): number | undefined {
  return positiveInteger(value) ? value : undefined;
}

function artifactPaths(paths: readonly string[], pkgRoot: string): {
  readonly manifestJson: string;
  readonly eventsJsonl: string;
  readonly userPcm: string;
  readonly assistantPcm: string;
  readonly userWav: string;
  readonly assistantWav: string;
  readonly callResultJson: string;
  readonly carrierInboundWav: string;
  readonly carrierOutboundWav: string;
} {
  const find = (suffix: string) => {
    const path = paths.find((candidate) => candidate.endsWith(suffix)) ?? "";
    return path ? join(pkgRoot, path) : "";
  };
  return {
    manifestJson: find("manifest.json"),
    eventsJsonl: find("events.jsonl"),
    userPcm: find("user_audio.pcm"),
    assistantPcm: find("assistant_audio.pcm"),
    userWav: find("user_audio.wav"),
    assistantWav: find("assistant_audio.wav"),
    callResultJson: find("call-result.json"),
    carrierInboundWav: find("carrier-inbound.wav"),
    carrierOutboundWav: find("carrier-outbound.wav"),
  };
}

async function readRecorderManifest(
  path: string,
  label: string,
  failures: string[],
): Promise<VoiceSessionRecorderManifest | null> {
  const parsed = await validateJsonFile(path, label, failures);
  const manifest = parsed;
  const manifestFailures = validateVoiceSessionRecorderManifest(manifest);
  failures.push(...manifestFailures.map((failure) => `${label} ${failure}`));
  if (manifestFailures.length > 0) return null;
  return manifest as VoiceSessionRecorderManifest;
}

async function validateJsonFile(path: string, label: string, failures: string[]): Promise<unknown | null> {
  if (!path) {
    failures.push(`${label} was not downloaded`);
    return null;
  }
  try {
    const text = await readFile(path, "utf8");
    if (!text.trim()) {
      failures.push(`${label} is empty`);
      return null;
    }
    return parseJson(text, label);
  } catch (err) {
    failures.push(`${label} could not be read: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function validateEventsJsonl(path: string, label: string, failures: string[]): Promise<number | null> {
  if (!path) {
    failures.push(`${label} was not downloaded`);
    return null;
  }
  try {
    const text = await readFile(path, "utf8");
    const lines = text.trim().split("\n").filter(Boolean);
    if (lines.length === 0) {
      failures.push(`${label} is empty`);
      return null;
    }
    const kinds = new Set<string>();
    for (const [index, line] of lines.entries()) {
      const lineLabel = `${label} line ${String(index + 1)}`;
      const event = parseJson(line, lineLabel);
      if (!isRecord(event)) {
        failures.push(`${lineLabel} must be an object`);
        return null;
      }
      const kind = event["kind"];
      if (typeof kind !== "string" || kind.length === 0) {
        failures.push(`${lineLabel} contains an event without kind`);
        return null;
      }
      validateRecorderEventShape(event, kind, lineLabel, failures);
      kinds.add(kind);
    }
    for (const required of ["record.user_audio", "stt.result", "llm.delta", "tts.audio", "record.assistant_audio"]) {
      if (!kinds.has(required)) failures.push(`${label} missing ${required}`);
    }
    return lines.length;
  } catch (err) {
    failures.push(`${label} could not be read: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function validateRecorderEventShape(
  event: Record<string, unknown>,
  kind: string,
  label: string,
  failures: string[],
): void {
  if (typeof event["route"] !== "string" || event["route"].length === 0) {
    failures.push(`${label} route must be a non-empty string`);
  }
  if (typeof event["context_id"] !== "string") {
    failures.push(`${label} context_id must be a string`);
  }
  if (!nonNegativeNumber(event["timestamp_ms"])) {
    failures.push(`${label} timestamp_ms must be a non-negative number`);
  }
  const packet = event["packet"];
  if (!isRecord(packet)) {
    failures.push(`${label} packet must be an object`);
    return;
  }
  if (packet["kind"] !== kind) {
    failures.push(`${label} packet.kind ${String(packet["kind"])} did not match event kind ${kind}`);
  }
  if (typeof packet["contextId"] !== "string") {
    failures.push(`${label} packet.contextId must be a string`);
  } else if (typeof event["context_id"] === "string" && packet["contextId"] !== event["context_id"]) {
    failures.push(`${label} packet.contextId ${packet["contextId"]} did not match event context_id ${event["context_id"]}`);
  }
  if (!nonNegativeNumber(packet["timestampMs"])) {
    failures.push(`${label} packet.timestampMs must be a non-negative number`);
  } else if (nonNegativeNumber(event["timestamp_ms"]) && packet["timestampMs"] !== event["timestamp_ms"]) {
    failures.push(`${label} packet.timestampMs ${String(packet["timestampMs"])} did not match event timestamp_ms ${String(event["timestamp_ms"])}`);
  }

  if (kind === "record.user_audio") {
    validateSanitizedAudio(packet["audio"], `${label} packet.audio`, failures);
  } else if (kind === "record.assistant_audio") {
    if (packet["truncate"] === true) return;
    if (packet["truncate"] !== false) failures.push(`${label} packet.truncate must be false for assistant audio data`);
    validateSanitizedAudio(packet["audio"], `${label} packet.audio`, failures);
    if (!positiveInteger(packet["sampleRateHz"])) failures.push(`${label} packet.sampleRateHz must be positive`);
  } else if (kind === "tts.audio") {
    validateSanitizedAudio(packet["audio"], `${label} packet.audio`, failures);
    if (!positiveInteger(packet["sampleRateHz"])) failures.push(`${label} packet.sampleRateHz must be positive`);
  } else if (kind === "stt.result" || kind === "llm.delta") {
    if (typeof packet["text"] !== "string" || packet["text"].length === 0) {
      failures.push(`${label} packet.text must be a non-empty string`);
    }
  }
}

function validateSanitizedAudio(
  value: unknown,
  label: string,
  failures: string[],
): void {
  if (!isRecord(value) || value["type"] !== "Uint8Array") {
    failures.push(`${label} must be sanitized Uint8Array metadata`);
    return;
  }
  if (!positiveInteger(value["byteLength"])) {
    failures.push(`${label}.byteLength must be positive`);
    return;
  }
  if (value["byteLength"] % 2 !== 0) {
    failures.push(`${label}.byteLength must be even PCM16 bytes`);
  }
}

async function validatePcmFile(
  path: string,
  label: string,
  expectedByteLength: number | undefined,
  failures: string[],
): Promise<void> {
  if (!path) {
    failures.push(`${label} was not downloaded`);
    return;
  }
  try {
    const info = await stat(path);
    if (info.size <= 0) failures.push(`${label} is empty`);
    if (info.size % 2 !== 0) failures.push(`${label} has odd PCM16 byte length`);
    if (expectedByteLength !== undefined && info.size !== expectedByteLength) {
      failures.push(`${label} byte length ${String(info.size)} did not match manifest ${String(expectedByteLength)}`);
    }
  } catch (err) {
    failures.push(`${label} could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function validateWavFile(
  path: string,
  label: string,
  expectedSampleRateHz: number | undefined,
  failures: string[],
  expectedDataByteLength?: number,
): Promise<void> {
  if (!path) {
    failures.push(`${label} was not downloaded`);
    return;
  }
  try {
    const info = readPcm16WavInfo(await readFile(path));
    if (expectedSampleRateHz !== undefined && info.sampleRateHz !== expectedSampleRateHz) {
      failures.push(`${label} sample rate ${String(info.sampleRateHz)} did not match expected ${String(expectedSampleRateHz)}`);
    }
    if (info.channels !== 1) failures.push(`${label} expected mono WAV, got ${String(info.channels)} channels`);
    if (info.bitsPerSample !== 16 || info.audioFormat !== 1) failures.push(`${label} expected 16-bit PCM WAV`);
    if (info.dataByteLength <= 0) failures.push(`${label} data chunk is empty`);
    if (info.dataByteLength % 2 !== 0) failures.push(`${label} data chunk has odd PCM16 byte length`);
    if (expectedDataByteLength !== undefined && info.dataByteLength !== expectedDataByteLength) {
      failures.push(`${label} data byte length ${String(info.dataByteLength)} did not match expected ${String(expectedDataByteLength)}`);
    }
  } catch (err) {
    failures.push(`${label} could not be validated: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function readPcm16WavInfo(buffer: Buffer): {
  readonly audioFormat: number;
  readonly channels: number;
  readonly sampleRateHz: number;
  readonly bitsPerSample: number;
  readonly dataByteLength: number;
} {
  if (buffer.byteLength < 44) throw new Error("WAV is too small");
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("missing RIFF/WAVE header");
  }
  let offset = 12;
  let audioFormat = 0;
  let channels = 0;
  let sampleRateHz = 0;
  let bitsPerSample = 0;
  let dataByteLength = 0;
  while (offset + 8 <= buffer.byteLength) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (dataOffset + size > buffer.byteLength) throw new Error(`WAV chunk ${id} exceeds file size`);
    if (id === "fmt ") {
      if (size < 16) throw new Error("WAV fmt chunk is too small");
      audioFormat = buffer.readUInt16LE(dataOffset);
      channels = buffer.readUInt16LE(dataOffset + 2);
      sampleRateHz = buffer.readUInt32LE(dataOffset + 4);
      bitsPerSample = buffer.readUInt16LE(dataOffset + 14);
    } else if (id === "data") {
      dataByteLength = size;
    }
    offset = dataOffset + size + (size % 2);
  }
  if (!audioFormat || !channels || !sampleRateHz || !bitsPerSample) throw new Error("WAV fmt chunk was missing");
  if (!dataByteLength) throw new Error("WAV data chunk was missing");
  return { audioFormat, channels, sampleRateHz, bitsPerSample, dataByteLength };
}

function renderBotFlyToml(app: string, region: string, memoryMb: number, publicBaseUrl: string): string {
  return `app = "${app}"
primary_region = "${region}"

[env]
  NODE_ENV = "production"
  SYRINX_SPIKE_ROLE = "bot"
  SYRINX_REVIEW_TTS = "cartesia"
  SYRINX_TELEPHONY_REVIEW_HOST = "0.0.0.0"
  SYRINX_TELEPHONY_REVIEW_PORT = "4180"
  SYRINX_TELEPHONY_PUBLIC_BASE_URL = "${publicBaseUrl}"

[http_service]
  internal_port = 4180
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0

[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory_mb = ${String(memoryMb)}
`;
}

function renderCarrierFlyToml(app: string, region: string, memoryMb: number, botBaseUrl: string, networkProfile: string): string {
  return `app = "${app}"
primary_region = "${region}"

[env]
  NODE_ENV = "production"
  SYRINX_SPIKE_ROLE = "synthetic-carrier"
  SYRINX_SYNTHETIC_CARRIER_HOST = "0.0.0.0"
  SYRINX_SYNTHETIC_CARRIER_PORT = "4180"
  SYRINX_SYNTHETIC_BOT_BASE_URL = "${botBaseUrl}"
  SYRINX_TELEPHONY_NETWORK_PROFILE = "${networkProfile}"

[http_service]
  internal_port = 4180
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0

[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory_mb = ${String(memoryMb)}
`;
}

async function createFlyApp(app: string): Promise<void> {
  await run("fly", ["apps", "create", app]);
}

async function importBotSecrets(app: string): Promise<void> {
  const names = [
    "DEEPGRAM_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "CARTESIA_API_KEY",
    "CARTESIA_VOICE_ID",
    "SYRINX_DEEPGRAM_MODEL",
    "SYRINX_DEEPGRAM_LANGUAGE",
    "SYRINX_REVIEW_TTS",
    "SYRINX_DEEPGRAM_TTS_MODEL",
  ];
  const lines: string[] = [];
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) lines.push(`${name}=${value}`);
  }
  for (const name of ["DEEPGRAM_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "CARTESIA_API_KEY"]) {
    if (!process.env[name]?.trim()) throw new Error(`${name} is required in .env for the Fly bot spike`);
  }
  await run("fly", ["secrets", "import", "--stage", "--app", app], { stdin: `${lines.join("\n")}\n`, redactOutput: true });
}

async function runSyntheticCall(carrierBaseUrl: string, provider: Provider, networkProfile: string): Promise<unknown> {
  const response = await fetch(`${carrierBaseUrl}/calls/university`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider, networkProfile }),
    signal: AbortSignal.timeout(240_000),
  });
  const text = await response.text();
  const parsed = parseJson(text, `${provider} carrier call response`);
  if (!response.ok) {
    throw new Error(`${provider} carrier call failed with HTTP ${String(response.status)}: ${text}`);
  }
  return parsed;
}

async function readBotArtifactPaths(botBaseUrl: string): Promise<Array<{ path: string; url: string }>> {
  const index = await fetchJson(`${botBaseUrl}/telephony/artifacts.json`) as ArtifactIndex;
  if (!Array.isArray(index.artifacts)) return [];
  return index.artifacts.flatMap((artifact) => {
    if (!artifact.path || !artifact.url) return [];
    return [{ path: artifact.path, url: artifact.url }];
  });
}

async function downloadBotArtifacts(
  botBaseUrl: string,
  artifacts: ReadonlyArray<{ readonly path: string; readonly url: string }>,
  outputDir: string,
): Promise<string[]> {
  const downloaded: string[] = [];
  for (const artifact of artifacts) {
    const outputPath = join(outputDir, artifact.path);
    await download(`${botBaseUrl}${artifact.url}`, outputPath);
    downloaded.push(outputPath);
  }
  return downloaded;
}

async function downloadCarrierArtifacts(carrierBaseUrl: string, callResult: unknown, outputDir: string): Promise<string[]> {
  const downloaded: string[] = [];
  await writeFile(join(outputDir, "call-result.json"), `${JSON.stringify(callResult, null, 2)}\n`, "utf8");
  downloaded.push(join(outputDir, "call-result.json"));
  if (!isRecord(callResult)) return downloaded;
  const carrierAudio = callResult["carrierAudio"];
  if (!isRecord(carrierAudio)) return downloaded;
  const inboundUrl = typeof carrierAudio["inboundWavUrl"] === "string" ? carrierAudio["inboundWavUrl"] : "";
  const outboundUrl = typeof carrierAudio["outboundWavUrl"] === "string" ? carrierAudio["outboundWavUrl"] : "";
  if (inboundUrl) {
    const outputPath = join(outputDir, "carrier-inbound.wav");
    await download(`${carrierBaseUrl}${inboundUrl}`, outputPath);
    downloaded.push(outputPath);
  }
  if (outboundUrl) {
    const outputPath = join(outputDir, "carrier-outbound.wav");
    await download(`${carrierBaseUrl}${outboundUrl}`, outputPath);
    downloaded.push(outputPath);
  }
  return downloaded;
}

async function download(url: string, outputPath: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`download failed ${url}: HTTP ${String(response.status)}`);
  const body = Buffer.from(await response.arrayBuffer());
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, body);
}

async function waitForOkJson(url: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  let lastError = "";
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (response.ok) return;
      lastError = `HTTP ${String(response.status)}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(3000);
  }
  throw new Error(`timed out waiting for ${url}: ${lastError}`);
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`fetch failed ${url}: HTTP ${String(response.status)} ${text}`);
  return parseJson(text, url);
}

async function destroyFlyApp(app: string): Promise<boolean> {
  try {
    await run("fly", ["apps", "destroy", app, "--yes"]);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Could not find App")) return true;
    console.error(`failed to destroy Fly app ${app}: ${message}`);
    return false;
  }
}

async function run(
  command: string,
  args: readonly string[],
  options: { readonly stdin?: string; readonly redactOutput?: boolean } = {},
): Promise<void> {
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      if (!options.redactOutput) process.stdout.write(chunk);
      output += Buffer.from(chunk).toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      if (!options.redactOutput) process.stderr.write(chunk);
      output += Buffer.from(chunk).toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolveRun();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with ${String(code)}${output ? `\n${output}` : ""}`));
      }
    });
    if (options.stdin) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

function readProviders(): Provider[] {
  const raw = process.env["SYRINX_FLY_SYNTHETIC_PROVIDERS"]?.trim();
  if (!raw) return [...DEFAULT_PROVIDERS];
  return raw.split(",").map((item) => {
    const provider = item.trim().toLowerCase();
    if (provider === "twilio" || provider === "telnyx" || provider === "smartpbx") return provider;
    throw new Error(`unsupported SYRINX_FLY_SYNTHETIC_PROVIDERS item: ${provider}`);
  });
}

function readSuffix(generatedAt: string): string {
  const explicit = process.env["SYRINX_FLY_APP_SUFFIX"]?.trim();
  const suffix = explicit || generatedAt.replace(/\D/g, "").slice(2, 14);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/.test(suffix)) {
    throw new Error("SYRINX_FLY_APP_SUFFIX must use lowercase letters, numbers, and dashes, and must not start or end with a dash");
  }
  return suffix;
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new Error(`${label} was not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isProvider(value: unknown): value is Provider {
  return value === "twilio" || value === "telnyx" || value === "smartpbx";
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => (typeof item === "string" ? [item] : []));
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
