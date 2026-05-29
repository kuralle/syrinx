// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

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

interface FlySpikeSummary {
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
  const failures = summary.providers.flatMap((provider) => {
    const callResult = provider["callResult"];
    if (!isRecord(callResult)) return [`${String(provider["provider"])} call result was not an object`];
    const qualityGate = callResult["qualityGate"];
    if (!isRecord(qualityGate) || qualityGate["passed"] !== true) {
      return [`${String(provider["provider"])} quality gate failed`];
    }
    const botArtifacts = provider["botArtifacts"];
    if (!Array.isArray(botArtifacts) || !botArtifacts.some((path) => String(path).endsWith("events.jsonl"))) {
      return [`${String(provider["provider"])} bot events.jsonl was not downloaded`];
    }
    if (!botArtifacts.some((path) => String(path).endsWith("user_audio.wav"))) {
      return [`${String(provider["provider"])} bot user_audio.wav was not downloaded`];
    }
    if (!botArtifacts.some((path) => String(path).endsWith("assistant_audio.wav"))) {
      return [`${String(provider["provider"])} bot assistant_audio.wav was not downloaded`];
    }
    return [];
  });
  if (summary.cleanup.botDestroyed !== true) failures.push(`bot Fly app was not destroyed: ${botApp}`);
  if (summary.cleanup.carrierDestroyed !== true) failures.push(`carrier Fly app was not destroyed: ${carrierApp}`);
  if (failures.length > 0) throw new Error(`Fly synthetic carrier spike failed: ${failures.join("; ")}`);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
