// SPDX-License-Identifier: MIT

import { writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { coerceGoogleGenAiKey, ensureRepoRootDotenv } from "../src/run-one-turn.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(SCRIPT_DIR, "..");
const RUNS_DIR = join(PKG_ROOT, "test", "performance", "runs");

type TwilioCallStatus =
  | "queued"
  | "initiated"
  | "ringing"
  | "in-progress"
  | "completed"
  | "busy"
  | "failed"
  | "no-answer"
  | "canceled";

interface TwilioCallResource {
  readonly sid: string;
  readonly status: TwilioCallStatus;
  readonly direction?: string;
  readonly duration?: string | null;
  readonly start_time?: string | null;
  readonly end_time?: string | null;
  readonly price?: string | null;
  readonly price_unit?: string | null;
  readonly error_code?: string | null;
  readonly error_message?: string | null;
}

interface TwilioConfig {
  readonly accountSid: string;
  readonly authToken: string;
  readonly from: string;
  readonly to: string;
  readonly publicBaseUrl: string;
  readonly twimlUrl: string;
  readonly statusCallbackUrl: string;
  readonly timeoutSeconds: number;
  readonly timeLimitSeconds: number;
  readonly pollIntervalMs: number;
  readonly pollTimeoutMs: number;
  readonly completeOnPollTimeout: boolean;
}

async function main(): Promise<void> {
  ensureRepoRootDotenv();
  coerceGoogleGenAiKey();
  const config = readTwilioConfig();
  assertHttpsPublicBaseUrl(config.publicBaseUrl);

  const generatedAt = new Date().toISOString();
  const runId = generatedAt.replaceAll(":", "-").replaceAll(".", "-");
  const runDir = join(RUNS_DIR, `twilio-carrier-call-${runId}`);
  const baselinePath = join(runDir, "baseline.json");

  const created = await createTwilioCall(config);
  const statuses: Array<{ readonly status: TwilioCallStatus; readonly observedAt: string }> = [{
    status: created.status,
    observedAt: new Date().toISOString(),
  }];
  let finalCall = created;
  let pollTimedOut = false;
  try {
    finalCall = await pollTwilioCall(config, created.sid, statuses);
  } catch (err) {
    pollTimedOut = true;
    if (!config.completeOnPollTimeout) throw err;
    await completeTwilioCall(config, created.sid);
    finalCall = await fetchTwilioCall(config, created.sid);
  }

  const failures = evaluateResult(finalCall, pollTimedOut);
  const baseline = {
    scenario: "twilio_real_carrier_call_smoke",
    generatedAt,
    provider: "twilio",
    twilio: {
      callSid: created.sid,
      direction: finalCall.direction ?? "unknown",
      initialStatus: created.status,
      finalStatus: finalCall.status,
      statusTimeline: statuses,
      durationSeconds: parseOptionalInteger(finalCall.duration),
      startTime: finalCall.start_time ?? null,
      endTime: finalCall.end_time ?? null,
      errorCode: finalCall.error_code ?? null,
      errorMessage: finalCall.error_message ?? null,
      price: finalCall.price ?? null,
      priceUnit: finalCall.price_unit ?? null,
    },
    request: {
      from: maskPhone(config.from),
      to: maskPhone(config.to),
      twimlUrl: config.twimlUrl,
      statusCallbackUrl: config.statusCallbackUrl,
      timeoutSeconds: config.timeoutSeconds,
      timeLimitSeconds: config.timeLimitSeconds,
      pollTimeoutMs: config.pollTimeoutMs,
      completeOnPollTimeout: config.completeOnPollTimeout,
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
  if (failures.length > 0) throw new Error(`twilio carrier call smoke failed: ${failures.join("; ")}`);
}

async function createTwilioCall(config: TwilioConfig): Promise<TwilioCallResource> {
  const body = new URLSearchParams({
    To: config.to,
    From: config.from,
    Url: config.twimlUrl,
    Method: "GET",
    StatusCallback: config.statusCallbackUrl,
    StatusCallbackMethod: "POST",
    Timeout: String(config.timeoutSeconds),
    TimeLimit: String(config.timeLimitSeconds),
  });
  body.append("StatusCallbackEvent", "initiated");
  body.append("StatusCallbackEvent", "ringing");
  body.append("StatusCallbackEvent", "answered");
  body.append("StatusCallbackEvent", "completed");

  const response = await twilioFetch(config, `/Calls.json`, {
    method: "POST",
    body,
  });
  return parseTwilioCallResource(response);
}

async function pollTwilioCall(
  config: TwilioConfig,
  callSid: string,
  statuses: Array<{ readonly status: TwilioCallStatus; readonly observedAt: string }>,
): Promise<TwilioCallResource> {
  const startedAt = Date.now();
  let previousStatus = statuses.at(-1)?.status;
  while (Date.now() - startedAt < config.pollTimeoutMs) {
    await sleep(config.pollIntervalMs);
    const call = await fetchTwilioCall(config, callSid);
    if (call.status !== previousStatus) {
      statuses.push({ status: call.status, observedAt: new Date().toISOString() });
      previousStatus = call.status;
    }
    if (isTerminalStatus(call.status)) return call;
  }
  throw new Error(`Twilio call ${callSid} did not reach a terminal status within ${String(config.pollTimeoutMs)} ms`);
}

async function fetchTwilioCall(config: TwilioConfig, callSid: string): Promise<TwilioCallResource> {
  const response = await twilioFetch(config, `/Calls/${encodeURIComponent(callSid)}.json`, { method: "GET" });
  return parseTwilioCallResource(response);
}

async function completeTwilioCall(config: TwilioConfig, callSid: string): Promise<void> {
  const body = new URLSearchParams({ Status: "completed" });
  await twilioFetch(config, `/Calls/${encodeURIComponent(callSid)}.json`, {
    method: "POST",
    body,
  });
}

async function twilioFetch(
  config: TwilioConfig,
  path: string,
  init: { readonly method: "GET" | "POST"; readonly body?: URLSearchParams },
): Promise<unknown> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}${path}`;
  const response = await fetch(url, {
    method: init.method,
    headers: {
      authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString("base64")}`,
      ...(init.body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: init.body,
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`Twilio API ${init.method} ${path} failed with HTTP ${String(response.status)}: ${summarizeTwilioError(parsed)}`);
  }
  return parsed;
}

function parseTwilioCallResource(value: unknown): TwilioCallResource {
  if (!isRecord(value)) throw new Error("Twilio Call response was not an object");
  const sid = readString(value, "sid");
  const status = readString(value, "status") as TwilioCallStatus | undefined;
  if (!sid) throw new Error("Twilio Call response did not include sid");
  if (!status || !isKnownCallStatus(status)) throw new Error(`Twilio Call response had unknown status: ${String(status)}`);
  return {
    sid,
    status,
    direction: readString(value, "direction"),
    duration: readNullableString(value, "duration"),
    start_time: readNullableString(value, "start_time"),
    end_time: readNullableString(value, "end_time"),
    price: readNullableString(value, "price"),
    price_unit: readNullableString(value, "price_unit"),
    error_code: readNullableString(value, "error_code"),
    error_message: readNullableString(value, "error_message"),
  };
}

function readTwilioConfig(): TwilioConfig {
  const publicBaseUrl = normalizeHttpBaseUrl(readEnv("SYRINX_TELEPHONY_PUBLIC_BASE_URL"));
  const twimlUrl = process.env["SYRINX_TWILIO_TWIML_URL"]?.trim() || `${publicBaseUrl}/twilio/twiml`;
  const statusCallbackUrl = process.env["SYRINX_TWILIO_STATUS_CALLBACK_URL"]?.trim() || `${publicBaseUrl}/twilio/status`;
  return {
    accountSid: readEnv("TWILIO_ACCOUNT_SID"),
    authToken: readEnv("TWILIO_AUTH_TOKEN"),
    from: readEnv("TWILIO_FROM_NUMBER"),
    to: readEnv("TWILIO_TO_NUMBER"),
    publicBaseUrl,
    twimlUrl,
    statusCallbackUrl,
    timeoutSeconds: readPositiveIntegerEnv("SYRINX_TWILIO_RING_TIMEOUT_SECONDS", 20),
    timeLimitSeconds: readPositiveIntegerEnv("SYRINX_TWILIO_TIME_LIMIT_SECONDS", 120),
    pollIntervalMs: readPositiveIntegerEnv("SYRINX_TWILIO_POLL_INTERVAL_MS", 3000),
    pollTimeoutMs: readPositiveIntegerEnv("SYRINX_TWILIO_POLL_TIMEOUT_MS", 180000),
    completeOnPollTimeout: readBooleanEnv("SYRINX_TWILIO_COMPLETE_ON_POLL_TIMEOUT", true),
  };
}

function evaluateResult(call: TwilioCallResource, pollTimedOut: boolean): string[] {
  const failures: string[] = [];
  if (pollTimedOut) failures.push("Twilio call polling timed out and the script requested call completion");
  if (call.status !== "completed") failures.push(`expected final Twilio status completed, got ${call.status}`);
  if (call.status === "completed" && parseOptionalInteger(call.duration) === 0) {
    failures.push("Twilio completed the call but reported zero seconds of duration");
  }
  if (call.error_code || call.error_message) {
    failures.push(`Twilio call reported error ${call.error_code ?? "unknown"}: ${call.error_message ?? ""}`.trim());
  }
  return failures;
}

function isTerminalStatus(status: TwilioCallStatus): boolean {
  return status === "completed" || status === "busy" || status === "failed" || status === "no-answer" || status === "canceled";
}

function isKnownCallStatus(status: string): status is TwilioCallStatus {
  return [
    "queued",
    "initiated",
    "ringing",
    "in-progress",
    "completed",
    "busy",
    "failed",
    "no-answer",
    "canceled",
  ].includes(status);
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
    throw new Error("Twilio carrier calls require SYRINX_TELEPHONY_PUBLIC_BASE_URL=https://...");
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

function summarizeTwilioError(value: unknown): string {
  if (!isRecord(value)) return String(value);
  const code = readString(value, "code");
  const message = readString(value, "message");
  const moreInfo = readString(value, "more_info");
  return [code, message, moreInfo].filter(Boolean).join(" ");
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

function parseOptionalInteger(value: string | null | undefined): number | null {
  if (!value?.trim()) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function maskPhone(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 4) return "****";
  return `${"*".repeat(Math.max(0, trimmed.length - 4))}${trimmed.slice(-4)}`;
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
