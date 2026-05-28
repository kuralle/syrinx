// SPDX-License-Identifier: MIT

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import WebSocket, { type RawData } from "ws";
import {
  decodeMuLawToPcm16,
  encodePcm16ToMuLaw,
  pcm16SamplesToBytes,
  resamplePcm16,
} from "@asyncdot/voice-server-websocket";

import {
  GEMINI_UNIVERSITY_FIXTURES,
  PKG_ROOT,
  ensureGeminiUniversityFixtures,
} from "./generate-gemini-university-fixtures.js";
import { ensureRepoRootDotenv, readPcm16Mono16kWav } from "../src/run-one-turn.js";

const require = createRequire(import.meta.url);
const { WaveFile } = require("wavefile") as typeof import("wavefile");

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = join(SCRIPT_DIR, "..", "test", "performance", "runs");
const ENGINE_SAMPLE_RATE_HZ = 16000;
const PHONE_SAMPLE_RATE_HZ = 8000;
const FRAME_DURATION_MS = 20;
const FRAME_SAMPLES = PHONE_SAMPLE_RATE_HZ * FRAME_DURATION_MS / 1000;
const POST_AUDIO_SILENCE_MS = 5000;
const SMARTPBX_OUTBOUND_QUIET_DRAIN_MS = 1500;
const STREAM_SID = "MZ-synthetic-carrier";
const CALL_SID = "CA-synthetic-carrier";
const TELNYX_STREAM_ID = "telnyx-synthetic-carrier-stream";
const TELNYX_CALL_CONTROL_ID = "telnyx-synthetic-carrier-call-control";
const SMARTPBX_CALL_ID = "smartpbx-synthetic-carrier-call";
const SMARTPBX_ACCOUNT_ID = "smartpbx-synthetic-carrier-account";

type TelephonyProvider = "twilio" | "telnyx" | "smartpbx";
type NetworkProfile = "clean" | "jittery" | "bursty";

interface CarrierCapture {
  networkProfile: NetworkProfile;
  inboundFrames: number;
  inboundWireBytes: number;
  inboundDecodedPcmBytes: number;
  outboundFrames: number;
  outboundWireBytes: number;
  outboundDecodedPcmBytes: number;
  outboundMarks: number;
  outboundEndMarks: number;
  localPlayoutDrains: number;
  outboundQuietDrains: number;
  firstInboundMediaAfterStartMs: number;
  lastInboundMediaAfterStartMs: number;
  maxInboundMediaGapMs: number;
  firstOutboundMediaAfterStartMs: number;
  lastOutboundMediaAfterStartMs: number;
}

interface CarrierAudioCapture {
  readonly inboundPcm8k: Int16Array[];
  readonly outboundPcm8k: Int16Array[];
}

interface SyntheticCallOptions {
  readonly provider: TelephonyProvider;
  readonly botBaseUrl: string;
  readonly networkProfile: NetworkProfile;
}

let latestRunDir = "";

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  await ensureGeminiUniversityFixtures();

  const host = process.env["SYRINX_SYNTHETIC_CARRIER_HOST"]?.trim() || "0.0.0.0";
  const port = readPort("SYRINX_SYNTHETIC_CARRIER_PORT", 4190);
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((err: unknown) => {
      console.error(err);
      if (!response.headersSent) {
        sendJson(response, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    });
  });
  await listen(server, port, host);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP server address");
  console.log(`Syrinx synthetic carrier host: http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${String(address.port)}`);
  console.log("POST /calls/university with { provider, botBaseUrl, networkProfile } to run a call.");
  process.once("SIGINT", () => server.close(() => process.exit(0)));
  process.once("SIGTERM", () => server.close(() => process.exit(0)));
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (url.pathname === "/healthz") {
    sendJson(response, 200, { ok: true, latestRunDir: latestRunDir ? relative(PKG_ROOT, latestRunDir) : "" });
    return;
  }

  if (url.pathname === "/calls/university" && request.method === "POST") {
    const body = await readJsonBody(request);
    const options = readSyntheticCallOptions(body);
    const result = await runSyntheticCarrierCall(options);
    sendJson(response, 200, result);
    return;
  }

  if (url.pathname.startsWith("/carrier/artifacts/")) {
    const artifactPath = decodeURIComponent(url.pathname.slice("/carrier/artifacts/".length));
    await sendCarrierArtifact(response, artifactPath);
    return;
  }

  sendJson(response, 404, { error: "not_found" });
}

async function runSyntheticCarrierCall(options: SyntheticCallOptions): Promise<Record<string, unknown>> {
  const generatedAt = new Date().toISOString();
  const runId = generatedAt.replaceAll(":", "-").replaceAll(".", "-");
  const runDir = join(RUNS_DIR, `synthetic-carrier-${options.provider}-${runId}`);
  latestRunDir = runDir;
  await mkdir(runDir, { recursive: true });

  const fixture = GEMINI_UNIVERSITY_FIXTURES[0]!;
  const botConfig = await fetchBotConfig(options.botBaseUrl);
  const websocketUrl = providerWebsocketUrl(botConfig, options.provider);
  const capture = createCarrierCapture(options.networkProfile);
  const audioCapture = createCarrierAudioCapture();
  const socket = new WebSocket(websocketUrl, { perMessageDeflate: false });
  const startedAt = Date.now();

  try {
    socket.on("message", (data, isBinary) => {
      captureOutbound(options.provider, capture, audioCapture, data, isBinary, startedAt, socket);
    });
    await waitForOpen(socket);
    sendStart(options.provider, socket);
    await sendFixtureAsPhoneMedia(options.provider, socket, fixture.path, capture, audioCapture, startedAt);
    await sendPhoneSilence(options.provider, socket, capture, audioCapture, startedAt, POST_AUDIO_SILENCE_MS);
    await waitForCarrierPlayoutDrain(options.provider, capture);
  } finally {
    sendStop(options.provider, socket);
    socket.close();
  }

  const carrierInboundWavPath = join(runDir, "carrier-inbound.wav");
  const carrierOutboundWavPath = join(runDir, "carrier-outbound.wav");
  await Promise.all([
    writePcm16Wav(carrierInboundWavPath, mergePcm16(audioCapture.inboundPcm8k), PHONE_SAMPLE_RATE_HZ),
    writePcm16Wav(carrierOutboundWavPath, mergePcm16(audioCapture.outboundPcm8k), PHONE_SAMPLE_RATE_HZ),
  ]);

  const result = {
    scenario: "synthetic_public_carrier_to_bot_call",
    generatedAt,
    provider: options.provider,
    botBaseUrl: normalizeBaseUrl(options.botBaseUrl),
    botArtifactIndexUrl: `${normalizeBaseUrl(options.botBaseUrl)}/telephony/artifacts.json`,
    websocketUrl,
    fixture: {
      id: fixture.id,
      expectedText: fixture.text,
    },
    carrier: capture,
    carrierAudio: {
      inboundWavPath: relative(PKG_ROOT, carrierInboundWavPath),
      outboundWavPath: relative(PKG_ROOT, carrierOutboundWavPath),
      inboundWavUrl: `/carrier/artifacts/${encodeURIComponent(relative(runDir, carrierInboundWavPath))}`,
      outboundWavUrl: `/carrier/artifacts/${encodeURIComponent(relative(runDir, carrierOutboundWavPath))}`,
    },
    artifacts: {
      runDir: relative(PKG_ROOT, runDir),
      baselinePath: relative(PKG_ROOT, join(runDir, "baseline.json")),
    },
    qualityGate: {
      passed: false,
      failures: [] as string[],
    },
  };
  result.qualityGate.failures = evaluateQuality(options.provider, capture);
  result.qualityGate.passed = result.qualityGate.failures.length === 0;
  await writeFile(join(runDir, "baseline.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  if (result.qualityGate.failures.length > 0) {
    throw new Error(`synthetic carrier call failed: ${result.qualityGate.failures.join("; ")}`);
  }
  return result;
}

async function fetchBotConfig(botBaseUrl: string): Promise<unknown> {
  const response = await fetch(`${normalizeBaseUrl(botBaseUrl)}/telephony/config.json`);
  if (!response.ok) throw new Error(`bot config fetch failed: ${String(response.status)} ${response.statusText}`);
  return await response.json();
}

function providerWebsocketUrl(config: unknown, provider: TelephonyProvider): string {
  const record = assertRecord(config, "telephony config");
  const providerConfig = assertRecord(record[provider], `${provider} config`);
  const websocketUrl = providerConfig["websocketUrl"];
  if (typeof websocketUrl !== "string" || !websocketUrl.trim()) throw new Error(`${provider}.websocketUrl missing`);
  return websocketUrl;
}

async function sendFixtureAsPhoneMedia(
  provider: TelephonyProvider,
  socket: WebSocket,
  fixturePath: string,
  capture: CarrierCapture,
  audioCapture: CarrierAudioCapture,
  startedAt: number,
): Promise<void> {
  const audio16k = readPcm16Mono16kWav(fixturePath);
  const audio8k = resamplePcm16(audio16k, ENGINE_SAMPLE_RATE_HZ, PHONE_SAMPLE_RATE_HZ);
  const delays = interFrameDelays(capture.networkProfile);
  let chunk = 1;
  for (let offset = 0; offset < audio8k.length; offset += FRAME_SAMPLES, chunk += 1) {
    const frame = new Int16Array(FRAME_SAMPLES);
    frame.set(audio8k.subarray(offset, Math.min(audio8k.length, offset + FRAME_SAMPLES)));
    sendPhoneFrame(provider, socket, frame, chunk, capture, audioCapture, startedAt);
    await sleep(delays[(chunk - 1) % delays.length] ?? FRAME_DURATION_MS);
  }
}

async function sendPhoneSilence(
  provider: TelephonyProvider,
  socket: WebSocket,
  capture: CarrierCapture,
  audioCapture: CarrierAudioCapture,
  startedAt: number,
  durationMs: number,
): Promise<void> {
  const frames = Math.ceil(durationMs / FRAME_DURATION_MS);
  const silence = new Int16Array(FRAME_SAMPLES);
  for (let i = 0; i < frames; i += 1) {
    sendPhoneFrame(provider, socket, silence, i + 1, capture, audioCapture, startedAt);
    await sleep(FRAME_DURATION_MS);
  }
}

function sendPhoneFrame(
  provider: TelephonyProvider,
  socket: WebSocket,
  frame: Int16Array,
  chunk: number,
  capture: CarrierCapture,
  audioCapture: CarrierAudioCapture,
  startedAt: number,
): void {
  const payload = Buffer.from(encodePcm16ToMuLaw(frame));
  capture.inboundFrames += 1;
  capture.inboundWireBytes += payload.byteLength;
  capture.inboundDecodedPcmBytes += frame.byteLength;
  audioCapture.inboundPcm8k.push(new Int16Array(frame));
  const sentAtMs = Date.now() - startedAt;
  if (capture.firstInboundMediaAfterStartMs < 0) capture.firstInboundMediaAfterStartMs = sentAtMs;
  if (capture.lastInboundMediaAfterStartMs >= 0) {
    capture.maxInboundMediaGapMs = Math.max(capture.maxInboundMediaGapMs, sentAtMs - capture.lastInboundMediaAfterStartMs);
  }
  capture.lastInboundMediaAfterStartMs = sentAtMs;

  if (provider === "twilio") {
    socket.send(JSON.stringify({
      event: "media",
      streamSid: STREAM_SID,
      media: {
        track: "inbound",
        chunk: String(chunk),
        timestamp: String(chunk * FRAME_DURATION_MS),
        payload: payload.toString("base64"),
      },
    }));
    return;
  }
  if (provider === "telnyx") {
    socket.send(JSON.stringify({
      event: "media",
      stream_id: TELNYX_STREAM_ID,
      media: {
        track: "inbound",
        chunk: String(chunk),
        timestamp: String(chunk * FRAME_DURATION_MS),
        payload: payload.toString("base64"),
      },
    }));
    return;
  }
  socket.send(JSON.stringify({
    event: "media",
    media: { payload: payload.toString("base64") },
  }));
}

function captureOutbound(
  provider: TelephonyProvider,
  capture: CarrierCapture,
  audioCapture: CarrierAudioCapture,
  data: RawData,
  isBinary: boolean,
  startedAt: number,
  socket: WebSocket,
): void {
  if (isBinary) return;
  const message = JSON.parse(data.toString()) as {
    event?: string;
    media?: { payload?: string };
    mark?: { name?: string };
  };
  if (message.event === "media" && message.media?.payload) {
    const payload = Buffer.from(message.media.payload, "base64");
    const decoded = decodeMuLawToPcm16(payload);
    capture.outboundFrames += 1;
    capture.outboundWireBytes += payload.byteLength;
    capture.outboundDecodedPcmBytes += decoded.byteLength;
    audioCapture.outboundPcm8k.push(decoded);
    const receivedAtMs = Date.now() - startedAt;
    if (capture.firstOutboundMediaAfterStartMs < 0) capture.firstOutboundMediaAfterStartMs = receivedAtMs;
    capture.lastOutboundMediaAfterStartMs = receivedAtMs;
  } else if (message.event === "mark") {
    capture.outboundMarks += 1;
    if (message.mark?.name?.endsWith(":end")) capture.outboundEndMarks += 1;
    if (provider === "twilio") {
      socket.send(JSON.stringify({ event: "mark", streamSid: STREAM_SID, mark: { name: message.mark?.name ?? "" } }));
    } else if (provider === "telnyx") {
      socket.send(JSON.stringify({ event: "mark", stream_id: TELNYX_STREAM_ID, mark: { name: message.mark?.name ?? "" } }));
    }
  }
}

async function waitForCarrierPlayoutDrain(provider: TelephonyProvider, capture: CarrierCapture): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 180_000) {
    if (provider === "smartpbx" && capture.outboundFrames > 0) {
      const quietForMs = Date.now() - startedAt - capture.lastOutboundMediaAfterStartMs;
      if (quietForMs >= SMARTPBX_OUTBOUND_QUIET_DRAIN_MS) {
        capture.outboundQuietDrains += 1;
        return;
      }
    } else if (capture.outboundFrames > 0 && capture.outboundEndMarks > 0) {
      return;
    }
    await sleep(100);
  }
  throw new Error(
    `timed out waiting for carrier playout drain: ` +
      `outboundFrames=${String(capture.outboundFrames)} ` +
      `outboundEndMarks=${String(capture.outboundEndMarks)} ` +
      `lastOutboundMediaAfterStartMs=${String(capture.lastOutboundMediaAfterStartMs)}`,
  );
}

function evaluateQuality(provider: TelephonyProvider, capture: CarrierCapture): string[] {
  const failures: string[] = [];
  if (capture.inboundFrames <= 0) failures.push("carrier inbound media frames were not sent");
  if (capture.outboundFrames <= 0) failures.push("carrier outbound media frames were not produced");
  if (capture.inboundWireBytes <= 0) failures.push("carrier inbound wire audio was empty");
  if (capture.outboundWireBytes <= 0) failures.push("carrier outbound wire audio was empty");
  if (capture.inboundDecodedPcmBytes <= 0) failures.push("carrier inbound decoded PCM was empty");
  if (capture.outboundDecodedPcmBytes <= 0) failures.push("carrier outbound decoded PCM was empty");
  if (provider !== "smartpbx" && capture.outboundEndMarks <= 0) failures.push("carrier terminal playback mark was not observed");
  if (capture.networkProfile !== "clean" && capture.maxInboundMediaGapMs <= FRAME_DURATION_MS) {
    failures.push(`${capture.networkProfile} network profile did not produce a measurable inbound media gap`);
  }
  if (capture.firstInboundMediaAfterStartMs < 0) failures.push("first inbound media timing was not recorded");
  if (capture.firstOutboundMediaAfterStartMs < 0) failures.push("first outbound media timing was not recorded");
  if (capture.lastOutboundMediaAfterStartMs < capture.firstOutboundMediaAfterStartMs) {
    failures.push("last outbound media preceded first outbound media");
  }
  if (provider === "smartpbx" && capture.outboundQuietDrains <= 0) failures.push("SmartPBX outbound quiet drain was not observed");
  if (capture.lastInboundMediaAfterStartMs < capture.firstInboundMediaAfterStartMs) {
    failures.push("last inbound media preceded first inbound media");
  }
  return failures;
}

function sendStart(provider: TelephonyProvider, socket: WebSocket): void {
  if (provider === "twilio") {
    socket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    socket.send(JSON.stringify({
      event: "start",
      streamSid: STREAM_SID,
      start: {
        streamSid: STREAM_SID,
        callSid: CALL_SID,
        mediaFormat: { encoding: "audio/x-mulaw", sampleRate: PHONE_SAMPLE_RATE_HZ, channels: 1 },
      },
    }));
    return;
  }
  if (provider === "telnyx") {
    socket.send(JSON.stringify({ event: "connected", version: "1.0.0" }));
    socket.send(JSON.stringify({
      event: "start",
      stream_id: TELNYX_STREAM_ID,
      start: {
        stream_id: TELNYX_STREAM_ID,
        call_control_id: TELNYX_CALL_CONTROL_ID,
        media_format: { encoding: "PCMU", sample_rate: PHONE_SAMPLE_RATE_HZ, channels: 1 },
      },
    }));
    return;
  }
  socket.send(JSON.stringify({
    event: "start",
    start: {
      callId: SMARTPBX_CALL_ID,
      otherLegCallId: "smartpbx-synthetic-carrier-peer",
      callerIdNumber: "+94770000000",
      calleeIdNumber: "+94771111111",
      accountId: SMARTPBX_ACCOUNT_ID,
      mediaFormat: { encoding: "g711_ulaw", sampleRate: PHONE_SAMPLE_RATE_HZ },
    },
  }));
}

function sendStop(provider: TelephonyProvider, socket: WebSocket): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (provider === "twilio") {
    socket.send(JSON.stringify({ event: "stop", streamSid: STREAM_SID, stop: { accountSid: "AC-synthetic-carrier" } }));
  } else if (provider === "telnyx") {
    socket.send(JSON.stringify({ event: "stop", stream_id: TELNYX_STREAM_ID }));
  } else {
    socket.send(JSON.stringify({ event: "hangup", hangup: { callId: SMARTPBX_CALL_ID, reason: "normal" } }));
  }
}

function createCarrierCapture(networkProfile: NetworkProfile): CarrierCapture {
  return {
    networkProfile,
    inboundFrames: 0,
    inboundWireBytes: 0,
    inboundDecodedPcmBytes: 0,
    outboundFrames: 0,
    outboundWireBytes: 0,
    outboundDecodedPcmBytes: 0,
    outboundMarks: 0,
    outboundEndMarks: 0,
    localPlayoutDrains: 0,
    outboundQuietDrains: 0,
    firstInboundMediaAfterStartMs: -1,
    lastInboundMediaAfterStartMs: -1,
    maxInboundMediaGapMs: 0,
    firstOutboundMediaAfterStartMs: -1,
    lastOutboundMediaAfterStartMs: -1,
  };
}

function createCarrierAudioCapture(): CarrierAudioCapture {
  return {
    inboundPcm8k: [],
    outboundPcm8k: [],
  };
}

function mergePcm16(chunks: readonly Int16Array[]): Int16Array {
  const sampleCount = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Int16Array(sampleCount);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

async function writePcm16Wav(outputPath: string, samples: Int16Array, sampleRateHz: number): Promise<void> {
  const wav = new WaveFile();
  wav.fromScratch(1, sampleRateHz, "16", samples);
  await writeFile(outputPath, Buffer.from(wav.toBuffer()));
}

function interFrameDelays(profile: NetworkProfile): readonly number[] {
  if (profile === "jittery") return [35, 5, 45, 10, 30, 15, 20];
  if (profile === "bursty") return [0, 0, 60, 0, 0, 60, 20];
  return [FRAME_DURATION_MS];
}

function readSyntheticCallOptions(body: unknown): SyntheticCallOptions {
  const record = assertRecord(body, "request body");
  const provider = readProvider(record["provider"]);
  const botBaseUrl = typeof record["botBaseUrl"] === "string" && record["botBaseUrl"].trim()
    ? record["botBaseUrl"].trim()
    : process.env["SYRINX_SYNTHETIC_BOT_BASE_URL"]?.trim();
  if (!botBaseUrl) throw new Error("botBaseUrl or SYRINX_SYNTHETIC_BOT_BASE_URL is required");
  return {
    provider,
    botBaseUrl,
    networkProfile: readNetworkProfile(record["networkProfile"]),
  };
}

function readProvider(value: unknown): TelephonyProvider {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!raw || raw === "twilio") return "twilio";
  if (raw === "telnyx" || raw === "smartpbx") return raw;
  throw new Error(`unsupported provider: ${raw}`);
}

function readNetworkProfile(value: unknown): NetworkProfile {
  const raw = (
    typeof value === "string" ? value : process.env["SYRINX_TELEPHONY_NETWORK_PROFILE"]
  )?.trim().toLowerCase();
  if (!raw || raw === "clean") return "clean";
  if (raw === "jittery" || raw === "bursty") return raw;
  throw new Error(`unsupported networkProfile: ${raw}`);
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("botBaseUrl must be http:// or https://");
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const body = await readRequestBody(request);
  if (!body.trim()) return {};
  return JSON.parse(body) as unknown;
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > 256 * 1024) throw new Error("request body exceeded 256 KiB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

async function sendCarrierArtifact(response: ServerResponse, artifactPath: string): Promise<void> {
  if (!latestRunDir) {
    sendJson(response, 404, { error: "no_carrier_run" });
    return;
  }
  const safePath = resolve(latestRunDir, artifactPath);
  const root = `${resolve(latestRunDir)}/`;
  if (!safePath.startsWith(root)) {
    sendJson(response, 400, { error: "invalid_artifact_path" });
    return;
  }
  const info = await stat(safePath);
  if (!info.isFile()) {
    sendJson(response, 404, { error: "artifact_not_found" });
    return;
  }
  response.writeHead(200, {
    "content-type": safePath.endsWith(".wav") ? "audio/wav" : "application/octet-stream",
    "content-length": String(info.size),
    "content-disposition": `attachment; filename="${basename(safePath).replaceAll('"', "")}"`,
    "cache-control": "no-store",
  });
  await new Promise<void>((resolveDone, reject) => {
    const stream = createReadStream(safePath);
    stream.once("error", reject);
    response.once("error", reject);
    response.once("finish", resolveDone);
    stream.pipe(response);
  });
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

function readPort(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const port = Number.parseInt(raw, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) throw new Error(`invalid ${name}: ${raw}`);
  return port;
}

async function waitForOpen(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolveOpen, reject) => {
    socket.once("open", resolveOpen);
    socket.once("error", reject);
  });
}

async function listen(server: ReturnType<typeof createServer>, port: number, host: string): Promise<void> {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
