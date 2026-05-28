// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { coerceGoogleGenAiKey, ensureRepoRootDotenv } from "../src/run-one-turn.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const RUNS_DIR = join(PKG_ROOT, "test", "performance", "runs");

interface TelnyxCallData {
  readonly call_control_id: string;
  readonly call_leg_id?: string;
  readonly call_session_id?: string;
  readonly is_alive?: boolean;
  readonly call_duration?: number;
  readonly start_time?: string | null;
  readonly end_time?: string | null;
}

interface TelnyxConfig {
  readonly apiKey: string;
  readonly connectionId: string;
  readonly from: string;
  readonly to: string;
  readonly publicBaseUrl: string;
  readonly streamUrl: string;
  readonly webhookUrl: string;
  readonly bidirectionalCodec: "PCMU" | "L16";
  readonly bidirectionalSamplingRate: 8000 | 16000;
  readonly timeoutSeconds: number;
  readonly timeLimitSeconds: number;
  readonly dwellMs: number;
  readonly hangupAfterDwell: boolean;
}

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  coerceGoogleGenAiKey();
  const config = readTelnyxConfig();
  assertHttpsPublicBaseUrl(config.publicBaseUrl);

  const generatedAt = new Date().toISOString();
  const runId = generatedAt.replaceAll(":", "-").replaceAll(".", "-");
  const runDir = join(RUNS_DIR, `telnyx-carrier-call-${runId}`);
  const baselinePath = join(runDir, "baseline.json");

  const created = await dialTelnyxCall(config);
  let hangupResult: unknown = null;
  await sleep(config.dwellMs);
  if (config.hangupAfterDwell) {
    hangupResult = await hangupTelnyxCall(config, created.call_control_id);
  }

  const failures = evaluateResult(created);
  const baseline = {
    scenario: "telnyx_real_carrier_call_smoke",
    generatedAt,
    provider: "telnyx",
    telnyx: {
      callControlId: created.call_control_id,
      callLegId: created.call_leg_id ?? null,
      callSessionId: created.call_session_id ?? null,
      isAlive: created.is_alive ?? null,
      callDurationSeconds: created.call_duration ?? null,
      startTime: created.start_time ?? null,
      endTime: created.end_time ?? null,
      hangupRequested: config.hangupAfterDwell,
      hangupResult,
    },
    request: {
      connectionId: maskId(config.connectionId),
      from: maskPhone(config.from),
      to: maskPhone(config.to),
      streamUrl: config.streamUrl,
      webhookUrl: config.webhookUrl,
      streamTrack: "both_tracks",
      streamBidirectionalMode: "rtp",
      streamBidirectionalCodec: config.bidirectionalCodec,
      streamBidirectionalSamplingRate: config.bidirectionalSamplingRate,
      streamEstablishBeforeCallOriginate: true,
      timeoutSeconds: config.timeoutSeconds,
      timeLimitSeconds: config.timeLimitSeconds,
      dwellMs: config.dwellMs,
    },
    artifacts: {
      runDir: relative(PKG_ROOT, runDir),
      baselinePath: relative(PKG_ROOT, baselinePath),
    },
    qualityGate: {
      passed: failures.length === 0,
      failures,
    },
  };
  await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(baseline, null, 2));
  if (failures.length > 0) throw new Error(`telnyx carrier call smoke failed: ${failures.join("; ")}`);
}

async function dialTelnyxCall(config: TelnyxConfig): Promise<TelnyxCallData> {
  const response = await telnyxFetch(config, "/calls", {
    method: "POST",
    body: {
      connection_id: config.connectionId,
      from: config.from,
      to: config.to,
      stream_url: config.streamUrl,
      stream_track: "both_tracks",
      stream_bidirectional_mode: "rtp",
      stream_bidirectional_codec: config.bidirectionalCodec,
      stream_bidirectional_sampling_rate: config.bidirectionalSamplingRate,
      stream_establish_before_call_originate: true,
      send_silence_when_idle: true,
      webhook_url: config.webhookUrl,
      webhook_url_method: "POST",
      timeout_secs: config.timeoutSeconds,
      time_limit_secs: config.timeLimitSeconds,
      command_id: `syrinx-${randomUUID()}`,
    },
  });
  return parseTelnyxCallData(response);
}

async function hangupTelnyxCall(config: TelnyxConfig, callControlId: string): Promise<unknown> {
  return telnyxFetch(config, `/calls/${encodeURIComponent(callControlId)}/actions/hangup`, {
    method: "POST",
    body: {
      command_id: `syrinx-hangup-${randomUUID()}`,
    },
  });
}

async function telnyxFetch(
  config: TelnyxConfig,
  path: string,
  init: { readonly method: "GET" | "POST"; readonly body?: Record<string, unknown> },
): Promise<unknown> {
  const response = await fetch(`https://api.telnyx.com/v2${path}`, {
    method: init.method,
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`Telnyx API ${init.method} ${path} failed with HTTP ${String(response.status)}: ${summarizeTelnyxError(parsed)}`);
  }
  return parsed;
}

function parseTelnyxCallData(value: unknown): TelnyxCallData {
  if (!isRecord(value) || !isRecord(value["data"])) throw new Error("Telnyx call response did not include data object");
  const data = value["data"];
  const callControlId = readString(data, "call_control_id");
  if (!callControlId) throw new Error("Telnyx call response did not include call_control_id");
  return {
    call_control_id: callControlId,
    call_leg_id: readString(data, "call_leg_id"),
    call_session_id: readString(data, "call_session_id"),
    is_alive: readBoolean(data, "is_alive"),
    call_duration: readNumber(data, "call_duration"),
    start_time: readNullableString(data, "start_time"),
    end_time: readNullableString(data, "end_time"),
  };
}

function readTelnyxConfig(): TelnyxConfig {
  const publicBaseUrl = normalizeHttpBaseUrl(readEnv("SYRINX_TELEPHONY_PUBLIC_BASE_URL"));
  const codec = readCodec();
  return {
    apiKey: readEnv("TELNYX_API_KEY"),
    connectionId: readEnv("TELNYX_CONNECTION_ID"),
    from: readEnv("TELNYX_FROM_NUMBER"),
    to: readEnv("TELNYX_TO_NUMBER"),
    publicBaseUrl,
    streamUrl: process.env["SYRINX_TELNYX_STREAM_URL"]?.trim() || `${publicBaseUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:")}/telnyx`,
    webhookUrl: process.env["SYRINX_TELNYX_WEBHOOK_URL"]?.trim() || `${publicBaseUrl}/telnyx/webhook`,
    bidirectionalCodec: codec,
    bidirectionalSamplingRate: codec === "L16" ? 16000 : 8000,
    timeoutSeconds: readPositiveIntegerEnv("SYRINX_TELNYX_RING_TIMEOUT_SECONDS", 20),
    timeLimitSeconds: readPositiveIntegerEnv("SYRINX_TELNYX_TIME_LIMIT_SECONDS", 120),
    dwellMs: readPositiveIntegerEnv("SYRINX_TELNYX_DWELL_MS", 45000),
    hangupAfterDwell: readBooleanEnv("SYRINX_TELNYX_HANGUP_AFTER_DWELL", true),
  };
}

function evaluateResult(call: TelnyxCallData): string[] {
  const failures: string[] = [];
  if (!call.call_control_id) failures.push("Telnyx did not return call_control_id");
  if (!call.call_leg_id) failures.push("Telnyx did not return call_leg_id");
  if (!call.call_session_id) failures.push("Telnyx did not return call_session_id");
  return failures;
}

function readCodec(): "PCMU" | "L16" {
  const raw = process.env["SYRINX_TELNYX_BIDIRECTIONAL_CODEC"]?.trim().toUpperCase();
  if (!raw || raw === "PCMU") return "PCMU";
  if (raw === "L16") return "L16";
  throw new Error(`unsupported SYRINX_TELNYX_BIDIRECTIONAL_CODEC: ${raw}`);
}

function normalizeHttpBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("SYRINX_TELEPHONY_PUBLIC_BASE_URL must use http:// or https://");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function assertHttpsPublicBaseUrl(value: string): void {
  if (!value.startsWith("https://")) {
    throw new Error("Telnyx carrier calls require SYRINX_TELEPHONY_PUBLIC_BASE_URL=https://...");
  }
}

function readEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  if (raw === "0" || raw === "false" || raw === "no") return false;
  throw new Error(`${name} must be true or false`);
}

function summarizeTelnyxError(value: unknown): string {
  if (!isRecord(value)) return String(value);
  const errors = value["errors"];
  if (Array.isArray(errors)) {
    return errors.map((item) => {
      if (!isRecord(item)) return String(item);
      return [readString(item, "code"), readString(item, "title"), readString(item, "detail")].filter(Boolean).join(" ");
    }).join("; ");
  }
  return JSON.stringify(value);
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
  const raw = value[key];
  return typeof raw === "string" && raw.trim() ? raw : undefined;
}

function readNullableString(value: Record<string, unknown>, key: string): string | null {
  const raw = value[key];
  if (raw === null || raw === undefined) return null;
  return typeof raw === "string" ? raw : String(raw);
}

function readBoolean(value: Record<string, unknown>, key: string): boolean | undefined {
  const raw = value[key];
  return typeof raw === "boolean" ? raw : undefined;
}

function readNumber(value: Record<string, unknown>, key: string): number | undefined {
  const raw = value[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function maskPhone(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 4) return "****";
  return `${"*".repeat(Math.max(0, trimmed.length - 4))}${trimmed.slice(-4)}`;
}

function maskId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 6) return "***";
  return `${trimmed.slice(0, 3)}...${trimmed.slice(-3)}`;
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
