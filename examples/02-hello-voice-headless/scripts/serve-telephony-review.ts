// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { type ConversationMetricPacket, type VoiceAgentSession } from "@asyncdot/voice";
import { createVoiceSessionRecorder } from "@asyncdot/voice-recorder";
import {
  createSmartPbxMediaStreamServer,
  createTelnyxMediaStreamServer,
  createTwilioMediaStreamServer,
} from "@asyncdot/voice-server-websocket";

import { coerceGoogleGenAiKey, ensureRepoRootDotenv } from "../src/run-one-turn.js";
import { createUniversitySupportSession, type UniversitySupportTtsProvider } from "../src/university-support-agent.js";

const require = createRequire(import.meta.url);
const { WaveFile } = require("wavefile") as typeof import("wavefile");

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(SCRIPT_DIR, "..");
const RUNS_DIR = join(PKG_ROOT, "test", "performance", "runs");
const INPUT_SAMPLE_RATE_HZ = 16000;
const ASSISTANT_SAMPLE_RATE_HZ = 16000;

type Carrier = "twilio" | "telnyx" | "smartpbx";

interface TelephonyReviewServer {
  readonly close: () => Promise<void>;
}

export async function main(): Promise<void> {
  ensureRepoRootDotenv();
  coerceGoogleGenAiKey();
  const ttsProvider = inferTtsProvider();
  requireLiveSpeechEnv(ttsProvider);

  const generatedAt = new Date().toISOString();
  const runId = generatedAt.replaceAll(":", "-").replaceAll(".", "-");
  const recordingDir = process.env["SYRINX_TELEPHONY_RECORDING_DIR"]?.trim()
    ? resolve(process.env["SYRINX_TELEPHONY_RECORDING_DIR"]!.trim())
    : join(RUNS_DIR, `telephony-live-review-${runId}`, "recorder");
  await mkdir(recordingDir, { recursive: true });

  const host = process.env["SYRINX_TELEPHONY_REVIEW_HOST"]?.trim() || "0.0.0.0";
  const port = readPort("SYRINX_TELEPHONY_REVIEW_PORT", 4180);
  const publicBaseUrl = readPublicBaseUrl();
  const publicWsBaseUrl = toPublicWsBaseUrl(publicBaseUrl);
  const httpServer = createServer((request, response) => {
    handleHttpRequest({
      request,
      response,
      publicBaseUrl,
      publicWsBaseUrl,
      ttsProvider,
      recordingDir,
    });
  });

  const [twilio, telnyx, smartpbx] = await Promise.all([
    createTwilioMediaStreamServer({
      server: httpServer,
      path: "/twilio",
      inputSampleRateHz: INPUT_SAMPLE_RATE_HZ,
      outputSampleRateHz: INPUT_SAMPLE_RATE_HZ,
      createSession: (request) => createLiveTelephonySession("twilio", request, ttsProvider, recordingDir),
    }),
    createTelnyxMediaStreamServer({
      server: httpServer,
      path: "/telnyx",
      inputSampleRateHz: INPUT_SAMPLE_RATE_HZ,
      outputSampleRateHz: INPUT_SAMPLE_RATE_HZ,
      bidirectionalCodec: readTelnyxCodec(),
      createSession: (request) => createLiveTelephonySession("telnyx", request, ttsProvider, recordingDir),
    }),
    createSmartPbxMediaStreamServer({
      server: httpServer,
      path: "/media-stream",
      inputSampleRateHz: INPUT_SAMPLE_RATE_HZ,
      outputSampleRateHz: INPUT_SAMPLE_RATE_HZ,
      createSession: (request) => createLiveTelephonySession("smartpbx", request, ttsProvider, recordingDir),
    }),
  ]);

  await listen(httpServer, port, host);
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("expected TCP server address");

  const localHttp = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${String(address.port)}`;
  const publicHttp = publicBaseUrl ?? localHttp;
  const publicWs = publicWsBaseUrl ?? localHttp.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  console.log(`Syrinx telephony live review server: ${localHttp}`);
  console.log(`Public base URL: ${publicHttp}`);
  console.log(`Twilio TwiML: ${publicHttp}/twilio/twiml`);
  console.log(`Twilio websocket: ${publicWs}/twilio`);
  console.log(`Telnyx websocket: ${publicWs}/telnyx`);
  console.log(`SmartPBX websocket: ${publicWs}/media-stream`);
  console.log(`Recorder output: ${relative(PKG_ROOT, recordingDir)}`);
  console.log(`TTS provider: ${ttsProvider}; engine PCM: ${String(INPUT_SAMPLE_RATE_HZ)} Hz mono s16le`);
  if (!publicBaseUrl?.startsWith("https://")) {
    console.log("Set SYRINX_TELEPHONY_PUBLIC_BASE_URL=https://... before live carrier calls; carriers require public TLS for wss.");
  }

  const reviewServer: TelephonyReviewServer = {
    close: async () => {
      await Promise.all([
        twilio.close().catch(() => undefined),
        telnyx.close().catch(() => undefined),
        smartpbx.close().catch(() => undefined),
      ]);
      await new Promise<void>((resolveClose) => {
        httpServer.close(() => resolveClose());
      });
    },
  };

  process.once("SIGINT", () => {
    void reviewServer.close().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void reviewServer.close().finally(() => process.exit(0));
  });
}

function handleHttpRequest(args: {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly publicBaseUrl: string | null;
  readonly publicWsBaseUrl: string | null;
  readonly ttsProvider: UniversitySupportTtsProvider;
  readonly recordingDir: string;
}): void {
  const { request, response } = args;
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const publicHttp = args.publicBaseUrl ?? `${url.protocol}//${request.headers.host ?? "localhost"}`;
  const publicWs = args.publicWsBaseUrl ?? publicHttp.replace(/^http:/, "ws:").replace(/^https:/, "wss:");

  if (url.pathname === "/healthz") {
    sendJson(response, 200, telephonyReviewHealthPayload(args.ttsProvider, args.recordingDir));
    return;
  }

  if (url.pathname === "/telephony/config.json") {
    sendJson(response, 200, carrierConfig(publicHttp, publicWs));
    return;
  }

  if (url.pathname === "/telephony/artifacts.json") {
    void listRecorderArtifacts(args.recordingDir)
      .then((artifacts) => {
        sendJson(response, 200, {
          recordingDir: relative(PKG_ROOT, args.recordingDir),
          artifacts,
        });
      })
      .catch((err: unknown) => {
        console.error(`artifact listing failed: ${err instanceof Error ? err.message : String(err)}`);
        sendJson(response, 500, { error: "artifact_listing_failed" });
      });
    return;
  }

  if (url.pathname.startsWith("/telephony/artifacts/")) {
    const artifactPath = decodeURIComponent(url.pathname.slice("/telephony/artifacts/".length));
    void sendRecorderArtifact(response, args.recordingDir, artifactPath)
      .catch((err: unknown) => {
        console.error(`artifact read failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!response.headersSent) sendJson(response, 404, { error: "artifact_not_found" });
      });
    return;
  }

  if (url.pathname === "/twilio/twiml") {
    const streamUrl = `${publicWs}/twilio`;
    sendXml(response, twilioConnectStreamXml(streamUrl, `${publicHttp}/twilio/status`));
    return;
  }

  if (url.pathname === "/twilio/status") {
    void readRequestBody(request)
      .then((body) => {
        console.log(`twilio status ${request.method ?? "GET"} ${url.search} ${body}`);
        sendJson(response, 200, { ok: true });
      })
      .catch((err: unknown) => {
        console.error(`twilio status read failed: ${err instanceof Error ? err.message : String(err)}`);
        sendJson(response, 400, { error: "invalid_status_body" });
      });
    return;
  }

  if (url.pathname === "/telnyx/webhook") {
    void readRequestBody(request)
      .then((body) => {
        console.log(`telnyx webhook ${request.method ?? "GET"} ${url.search} ${body}`);
        sendJson(response, 200, { ok: true });
      })
      .catch((err: unknown) => {
        console.error(`telnyx webhook read failed: ${err instanceof Error ? err.message : String(err)}`);
        sendJson(response, 400, { error: "invalid_webhook_body" });
      });
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    sendJson(response, 200, {
      service: "syrinx-telephony-review",
      config: carrierConfig(publicHttp, publicWs),
    });
    return;
  }

  sendJson(response, 404, { error: "not_found" });
}

export function telephonyReviewHealthPayload(
  ttsProvider: UniversitySupportTtsProvider,
  recordingDir: string,
): Record<string, unknown> {
  return {
    ok: true,
    ttsProvider,
    inputSampleRateHz: INPUT_SAMPLE_RATE_HZ,
    engineOutputSampleRateHz: INPUT_SAMPLE_RATE_HZ,
    recorderAssistantSampleRateHz: expectedTtsProviderSampleRateHz(ttsProvider),
    recordingDir: relative(PKG_ROOT, recordingDir),
  };
}

function expectedTtsProviderSampleRateHz(ttsProvider: UniversitySupportTtsProvider): number {
  return ttsProvider === "cartesia" ? 16000 : 24000;
}

function carrierConfig(publicHttp: string, publicWs: string): Record<string, unknown> {
  return {
    twilio: {
      twimlUrl: `${publicHttp}/twilio/twiml`,
      websocketUrl: `${publicWs}/twilio`,
      expected: {
        stream: "bidirectional <Connect><Stream>",
        inboundCodec: "PCMU/8000 mono from Twilio",
        outboundCodec: "PCMU/8000 mono paced 20 ms media frames",
      },
    },
    telnyx: {
      websocketUrl: `${publicWs}/telnyx`,
      webhookUrl: `${publicHttp}/telnyx/webhook`,
      callFields: {
        stream_url: `${publicWs}/telnyx`,
        stream_track: "both_tracks",
        stream_bidirectional_mode: "rtp",
        stream_bidirectional_codec: readTelnyxCodec(),
        webhook_url: `${publicHttp}/telnyx/webhook`,
        webhook_url_method: "POST",
      },
    },
    smartpbx: {
      websocketUrl: `${publicWs}/media-stream`,
      expected: {
        encodings: ["g711_ulaw/8000", "pcm16/24000", "opus/48000"],
        outboundIdentity: ["callId", "accountId"],
      },
    },
  };
}

function twilioConnectStreamXml(streamUrl: string, statusCallback: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    "  <Connect>",
    `    <Stream url="${xmlEscape(streamUrl)}" statusCallback="${xmlEscape(statusCallback)}" statusCallbackMethod="POST">`,
    '      <Parameter name="syrinxProfile" value="university-support" />',
    "    </Stream>",
    "  </Connect>",
    "</Response>",
  ].join("\n");
}

function createLiveTelephonySession(
  carrier: Carrier,
  request: IncomingMessage,
  ttsProvider: UniversitySupportTtsProvider,
  recordingDir: string,
): VoiceAgentSession {
  const sessionId = `${carrier}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  console.log(`${carrier} websocket connected from ${request.socket.remoteAddress ?? "unknown"} session=${sessionId}`);
  const session = createUniversitySupportSession({
    inputSampleRate: INPUT_SAMPLE_RATE_HZ,
    profile: "interactive",
    ttsProvider,
  });
  session.registerPlugin("recorder", createVoiceSessionRecorder({
    outputDir: recordingDir,
    sessionId,
    userSampleRateHz: INPUT_SAMPLE_RATE_HZ,
    assistantSampleRateHz: ASSISTANT_SAMPLE_RATE_HZ,
  }));
  session.bus.on("metric.conversation", (pkt) => {
    const metric = pkt as ConversationMetricPacket;
    console.log(`${carrier} metric ${metric.contextId} ${metric.name}=${metric.value}`);
  });
  session.on("user_input_final", (event) => {
    console.log(`${carrier} stt ${event.turnId}: ${event.text}`);
  });
  session.on("agent_finished", (event) => {
    console.log(`${carrier} agent finished ${event.turnId}`);
  });
  session.on("error", (event) => {
    console.error(`${carrier} error ${event.stage}/${event.category}: ${event.message}`);
  });
  return session;
}

function inferTtsProvider(): UniversitySupportTtsProvider {
  const requested = process.env["SYRINX_REVIEW_TTS"]?.trim().toLowerCase();
  if (requested === "gemini" || requested === "cartesia" || requested === "deepgram") return requested;
  return process.env["CARTESIA_API_KEY"]?.trim() ? "cartesia" : "gemini";
}

function requireLiveSpeechEnv(ttsProvider: UniversitySupportTtsProvider): void {
  requireEnv("DEEPGRAM_API_KEY");
  requireEnv("GOOGLE_GENERATIVE_AI_API_KEY");
  if (ttsProvider === "cartesia") requireEnv("CARTESIA_API_KEY");
}

function requireEnv(name: string): void {
  if (!process.env[name]?.trim()) throw new Error(`${name} is required`);
}

function readPort(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const port = Number.parseInt(raw, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) throw new Error(`invalid ${name}: ${raw}`);
  return port;
}

function readPublicBaseUrl(): string | null {
  const raw = process.env["SYRINX_TELEPHONY_PUBLIC_BASE_URL"]?.trim();
  if (!raw) return null;
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("SYRINX_TELEPHONY_PUBLIC_BASE_URL must be http:// or https://");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function toPublicWsBaseUrl(publicBaseUrl: string | null): string | null {
  if (!publicBaseUrl) return null;
  return publicBaseUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
}

function readTelnyxCodec(): "PCMU" | "L16" {
  const raw = process.env["SYRINX_TELNYX_BIDIRECTIONAL_CODEC"]?.trim().toUpperCase();
  if (!raw || raw === "PCMU") return "PCMU";
  if (raw === "L16") return "L16";
  throw new Error(`unsupported SYRINX_TELNYX_BIDIRECTIONAL_CODEC: ${raw}`);
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

async function listRecorderArtifacts(recordingDir: string): Promise<Array<{ path: string; url: string; source?: string }>> {
  const files = await walkFiles(recordingDir);
  const artifacts: Array<{ path: string; url: string; source?: string }> = files.map((filePath) => {
    const rel = relative(recordingDir, filePath);
    return {
      path: rel,
      url: `/telephony/artifacts/${encodeURIComponent(rel).replaceAll("%2F", "/")}`,
    };
  });
  for (const filePath of files) {
    const rel = relative(recordingDir, filePath);
    if (rel.endsWith("user_audio.pcm")) {
      const wavRel = rel.replace(/user_audio\.pcm$/, "user_audio.wav");
      artifacts.push({
        path: wavRel,
        url: `/telephony/artifacts/${encodeURIComponent(wavRel).replaceAll("%2F", "/")}`,
        source: rel,
      });
    }
    if (rel.endsWith("assistant_audio.pcm")) {
      const wavRel = rel.replace(/assistant_audio\.pcm$/, "assistant_audio.wav");
      artifacts.push({
        path: wavRel,
        url: `/telephony/artifacts/${encodeURIComponent(wavRel).replaceAll("%2F", "/")}`,
        source: rel,
      });
    }
  }
  return artifacts.sort((a, b) => String(a.path).localeCompare(String(b.path)));
}

async function walkFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile()) {
        output.push(fullPath);
      }
    }
  }
  await visit(root);
  return output.sort();
}

async function sendRecorderArtifact(response: ServerResponse, recordingDir: string, artifactPath: string): Promise<void> {
  if (artifactPath.endsWith("user_audio.wav")) {
    await sendPcmAsWav(response, recordingDir, artifactPath.replace(/user_audio\.wav$/, "user_audio.pcm"), INPUT_SAMPLE_RATE_HZ);
    return;
  }
  if (artifactPath.endsWith("assistant_audio.wav")) {
    const pcmArtifactPath = artifactPath.replace(/assistant_audio\.wav$/, "assistant_audio.pcm");
    const sampleRateHz = await readRecorderPcmSampleRateHz(recordingDir, pcmArtifactPath, "assistant");
    await sendPcmAsWav(response, recordingDir, pcmArtifactPath, sampleRateHz);
    return;
  }
  const safePath = resolve(recordingDir, artifactPath);
  const root = `${resolve(recordingDir)}/`;
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
    "content-type": artifactContentType(safePath),
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

export async function readRecorderPcmSampleRateHz(
  recordingDir: string,
  pcmArtifactPath: string,
  track: "user" | "assistant",
): Promise<number> {
  if (track === "user") return INPUT_SAMPLE_RATE_HZ;

  const safePcmPath = resolve(recordingDir, pcmArtifactPath);
  const root = `${resolve(recordingDir)}/`;
  if (!safePcmPath.startsWith(root)) {
    throw new Error("invalid_artifact_path");
  }

  const manifestPath = join(dirname(safePcmPath), "manifest.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  } catch (err) {
    throw new Error(`assistant audio sample rate is unknown without recorder manifest ${relative(recordingDir, manifestPath)}`, { cause: err });
  }

  const sampleRateHz = readManifestSampleRateHz(parsed, track);
  if (sampleRateHz === undefined) {
    throw new Error(`recorder manifest ${relative(recordingDir, manifestPath)} does not contain audio.${track}.sampleRateHz`);
  }
  return sampleRateHz;
}

function readManifestSampleRateHz(manifest: unknown, track: "user" | "assistant"): number | undefined {
  if (!manifest || typeof manifest !== "object") return undefined;
  const audio = (manifest as { audio?: unknown }).audio;
  if (!audio || typeof audio !== "object") return undefined;
  const section = (audio as Record<string, unknown>)[track];
  if (!section || typeof section !== "object") return undefined;
  const sampleRateHz = (section as { sampleRateHz?: unknown }).sampleRateHz;
  return typeof sampleRateHz === "number" && Number.isInteger(sampleRateHz) && sampleRateHz > 0
    ? sampleRateHz
    : undefined;
}

async function sendPcmAsWav(
  response: ServerResponse,
  recordingDir: string,
  pcmArtifactPath: string,
  sampleRateHz: number,
): Promise<void> {
  const safePath = resolve(recordingDir, pcmArtifactPath);
  const root = `${resolve(recordingDir)}/`;
  if (!safePath.startsWith(root)) {
    sendJson(response, 400, { error: "invalid_artifact_path" });
    return;
  }
  const pcm = await readFile(safePath);
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  const wav = new WaveFile();
  wav.fromScratch(1, sampleRateHz, "16", samples);
  const output = Buffer.from(wav.toBuffer());
  response.writeHead(200, {
    "content-type": "audio/wav",
    "content-length": String(output.byteLength),
    "content-disposition": `attachment; filename="${basename(pcmArtifactPath).replace(/\.pcm$/, ".wav")}"`,
    "cache-control": "no-store",
  });
  response.end(output);
}

function artifactContentType(path: string): string {
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".jsonl")) return "application/x-ndjson; charset=utf-8";
  if (path.endsWith(".wav")) return "audio/wav";
  if (path.endsWith(".pcm")) return "application/octet-stream";
  return "application/octet-stream";
}

function sendXml(response: ServerResponse, value: string): void {
  response.writeHead(200, {
    "content-type": "text/xml; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${value}\n`);
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

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
