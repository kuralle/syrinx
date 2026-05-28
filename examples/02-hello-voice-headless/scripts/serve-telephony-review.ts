// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type ConversationMetricPacket, type VoiceAgentSession } from "@asyncdot/voice";
import { createVoiceSessionRecorder } from "@asyncdot/voice-recorder";
import {
  createSmartPbxMediaStreamServer,
  createTelnyxMediaStreamServer,
  createTwilioMediaStreamServer,
} from "@asyncdot/voice-server-websocket";

import { coerceGoogleGenAiKey, ensureRepoRootDotenv } from "../src/run-one-turn.js";
import { createUniversitySupportSession, type UniversitySupportTtsProvider } from "../src/university-support-agent.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(SCRIPT_DIR, "..");
const RUNS_DIR = join(PKG_ROOT, "test", "performance", "runs");
const INPUT_SAMPLE_RATE_HZ = 16000;
const ASSISTANT_SAMPLE_RATE_HZ = 16000;

type Carrier = "twilio" | "telnyx" | "smartpbx";

interface TelephonyReviewServer {
  readonly close: () => Promise<void>;
}

async function main(): Promise<void> {
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
    sendJson(response, 200, {
      ok: true,
      ttsProvider: args.ttsProvider,
      inputSampleRateHz: INPUT_SAMPLE_RATE_HZ,
      assistantSampleRateHz: ASSISTANT_SAMPLE_RATE_HZ,
      recordingDir: relative(PKG_ROOT, args.recordingDir),
    });
    return;
  }

  if (url.pathname === "/telephony/config.json") {
    sendJson(response, 200, carrierConfig(publicHttp, publicWs));
    return;
  }

  if (url.pathname === "/twilio/twiml") {
    const streamUrl = `${publicWs}/twilio`;
    sendXml(response, twilioConnectStreamXml(streamUrl, `${publicHttp}/twilio/status`));
    return;
  }

  if (url.pathname === "/twilio/status") {
    console.log(`twilio status ${request.method ?? "GET"} ${url.search}`);
    sendJson(response, 200, { ok: true });
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
      callFields: {
        stream_url: `${publicWs}/telnyx`,
        stream_track: "both_tracks",
        stream_bidirectional_mode: "rtp",
        stream_bidirectional_codec: readTelnyxCodec(),
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
  if (requested === "gemini" || requested === "cartesia") return requested;
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

function sendXml(response: ServerResponse, value: string): void {
  response.writeHead(200, {
    "content-type": "text/xml; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${value}\n`);
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

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
