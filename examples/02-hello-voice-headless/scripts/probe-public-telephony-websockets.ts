// SPDX-License-Identifier: MIT

import WebSocket, { type RawData } from "ws";

type Provider = "twilio" | "telnyx" | "smartpbx";

interface ProbeResult {
  readonly provider: Provider;
  readonly ok: boolean;
  readonly url: string;
  readonly messages: number;
  readonly extensions: string;
}

const PCMU_SILENCE_20MS = Buffer.alloc(160, 0xff).toString("base64");

async function main(): Promise<void> {
  const publicBaseUrl = readPublicBaseUrl();
  const httpBaseUrl = normalizeHttpBaseUrl(publicBaseUrl);
  const wsBaseUrl = httpBaseUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:");

  const health = await fetchJson(`${httpBaseUrl}/healthz`);
  const config = await fetchJson(`${httpBaseUrl}/telephony/config.json`);
  const twiml = await fetchText(`${httpBaseUrl}/twilio/twiml`);
  const [twilioStatus, telnyxWebhook] = await Promise.all([
    postForm(`${httpBaseUrl}/twilio/status`, new URLSearchParams({
      CallSid: "CA-public-probe",
      CallStatus: "initiated",
    })),
    postJson(`${httpBaseUrl}/telnyx/webhook`, {
      data: {
        event_type: "call.initiated",
        payload: {
          call_control_id: "telnyx-public-probe-call",
        },
      },
    }),
  ]);
  assertHealth(health);
  assertCarrierConfig(config, wsBaseUrl);
  assertOkResponse(twilioStatus, "/twilio/status");
  assertOkResponse(telnyxWebhook, "/telnyx/webhook");
  if (!twiml.includes("<Connect>") || !twiml.includes("<Stream")) {
    throw new Error("/twilio/twiml did not return bidirectional Connect Stream TwiML");
  }

  const results = await Promise.all([
    probeTwilio(`${wsBaseUrl}/twilio`),
    probeTelnyx(`${wsBaseUrl}/telnyx`),
    probeSmartPbx(`${wsBaseUrl}/media-stream`),
  ]);

  const failures = results.flatMap((result) => {
    const resultFailures: string[] = [];
    if (!result.ok) resultFailures.push(`${result.provider} websocket probe failed`);
    if (result.extensions !== "") {
      resultFailures.push(`${result.provider} negotiated websocket extensions: ${result.extensions}`);
    }
    return resultFailures;
  });

  const report = {
    publicBaseUrl: httpBaseUrl,
    health,
    twiml: {
      ok: true,
      hasConnectStream: true,
    },
    callbacks: {
      twilioStatus,
      telnyxWebhook,
    },
    websocketProbes: results,
    qualityGate: {
      passed: failures.length === 0,
      failures,
    },
  };
  console.log(JSON.stringify(report, null, 2));
  if (failures.length > 0) throw new Error(`public telephony probe failed: ${failures.join("; ")}`);
}

async function probeTwilio(url: string): Promise<ProbeResult> {
  return probeProvider("twilio", url, (socket) => {
    socket.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
    socket.send(JSON.stringify({
      event: "start",
      streamSid: "MZ-public-probe",
      start: {
        streamSid: "MZ-public-probe",
        callSid: "CA-public-probe",
        mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
      },
    }));
    socket.send(JSON.stringify({
      event: "media",
      streamSid: "MZ-public-probe",
      media: { payload: PCMU_SILENCE_20MS },
    }));
    socket.send(JSON.stringify({
      event: "stop",
      streamSid: "MZ-public-probe",
      stop: { accountSid: "AC-public-probe" },
    }));
  });
}

async function probeTelnyx(url: string): Promise<ProbeResult> {
  return probeProvider("telnyx", url, (socket) => {
    socket.send(JSON.stringify({
      event: "start",
      stream_id: "telnyx-public-probe-stream",
      start: {
        stream_id: "telnyx-public-probe-stream",
        call_control_id: "telnyx-public-probe-call",
        media_format: { encoding: "PCMU", sample_rate: 8000, channels: 1 },
      },
    }));
    socket.send(JSON.stringify({
      event: "media",
      stream_id: "telnyx-public-probe-stream",
      media: { payload: PCMU_SILENCE_20MS },
    }));
    socket.send(JSON.stringify({ event: "stop", stream_id: "telnyx-public-probe-stream" }));
  });
}

async function probeSmartPbx(url: string): Promise<ProbeResult> {
  return probeProvider("smartpbx", url, (socket) => {
    socket.send(JSON.stringify({
      event: "start",
      callId: "smartpbx-public-probe-call",
      accountId: "smartpbx-public-probe-account",
      mediaFormat: { encoding: "g711_ulaw", sampleRate: 8000 },
    }));
    socket.send(JSON.stringify({
      event: "media",
      callId: "smartpbx-public-probe-call",
      accountId: "smartpbx-public-probe-account",
      media: { payload: PCMU_SILENCE_20MS },
    }));
    socket.send(JSON.stringify({
      event: "hangup",
      hangup: { callId: "smartpbx-public-probe-call", reason: "public_probe" },
    }));
  });
}

async function probeProvider(
  provider: Provider,
  url: string,
  sendFrames: (socket: WebSocket) => void,
): Promise<ProbeResult> {
  const socket = new WebSocket(url, { perMessageDeflate: false });
  let messages = 0;
  socket.on("message", (_data: RawData) => {
    messages += 1;
  });

  await waitForOpen(socket, provider);
  const extensions = socket.extensions;
  sendFrames(socket);
  await sleep(readProbeDwellMs());
  socket.close(1000, "public probe complete");
  await waitForClose(socket, provider);
  return { provider, ok: true, url, messages, extensions };
}

function readPublicBaseUrl(): string {
  const fromArg = process.argv[2]?.trim();
  const fromEnv = process.env["SYRINX_TELEPHONY_PUBLIC_BASE_URL"]?.trim();
  const value = fromArg || fromEnv;
  if (!value) {
    throw new Error("SYRINX_TELEPHONY_PUBLIC_BASE_URL or first CLI argument is required");
  }
  return value;
}

function normalizeHttpBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("public base URL must use http:// or https://");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned HTTP ${String(response.status)}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error(`${url} returned non-JSON content-type ${contentType}`);
  }
  return response.json();
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned HTTP ${String(response.status)}`);
  return response.text();
}

async function postForm(url: string, body: URLSearchParams): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${String(response.status)}`);
  return response.json();
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${String(response.status)}`);
  return response.json();
}

function assertHealth(value: unknown): void {
  if (!isRecord(value) || value["ok"] !== true) {
    throw new Error("/healthz did not return ok:true");
  }
}

function assertCarrierConfig(value: unknown, wsBaseUrl: string): void {
  if (!isRecord(value)) throw new Error("/telephony/config.json did not return an object");
  assertNestedUrl(value, ["twilio", "websocketUrl"], `${wsBaseUrl}/twilio`);
  assertNestedUrl(value, ["telnyx", "websocketUrl"], `${wsBaseUrl}/telnyx`);
  assertNestedUrl(value, ["smartpbx", "websocketUrl"], `${wsBaseUrl}/media-stream`);
  assertNestedUrl(value, ["telnyx", "webhookUrl"], `${wsBaseUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:")}/telnyx/webhook`);
}

function assertOkResponse(value: unknown, label: string): void {
  if (!isRecord(value) || value["ok"] !== true) {
    throw new Error(`${label} did not return ok:true`);
  }
}

function assertNestedUrl(value: Record<string, unknown>, path: readonly string[], expected: string): void {
  let cursor: unknown = value;
  for (const segment of path) {
    if (!isRecord(cursor)) throw new Error(`/telephony/config.json missing ${path.join(".")}`);
    cursor = cursor[segment];
  }
  if (cursor !== expected) {
    throw new Error(`/telephony/config.json ${path.join(".")} expected ${expected}, got ${String(cursor)}`);
  }
}

function waitForOpen(socket: WebSocket, provider: Provider): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`${provider} websocket did not open before timeout`));
    }, readProbeTimeoutMs());
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("open", onOpen);
      socket.off("error", onError);
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
  });
}

function waitForClose(socket: WebSocket, provider: Provider): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`${provider} websocket did not close before timeout`));
    }, readProbeTimeoutMs());
    const onClose = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

function readProbeTimeoutMs(): number {
  return readPositiveIntegerEnv("SYRINX_TELEPHONY_PUBLIC_PROBE_TIMEOUT_MS", 5000);
}

function readProbeDwellMs(): number {
  return readPositiveIntegerEnv("SYRINX_TELEPHONY_PUBLIC_PROBE_DWELL_MS", 250);
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
