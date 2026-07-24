// SPDX-License-Identifier: MIT
//
// Pure carrier out-of-band command constructors + injectable fetch dispatchers.
// Workers-safe: TypedArray-free pure objects + global `fetch()` only.
// No Node APIs, no process.env — credentials and call handles are injected.
//
// HONESTY: payload shapes unit-tested. Live HTTP dispatch to Twilio/Telnyx is
// unverified against a live carrier (no credentials in this build). Real IVR
// DTMF decode, trunk G.722 negotiation, and live transfer bridge remain
// carrier-gated.

import type { CallTransferPacket, DtmfSendPacket } from "@kuralle-syrinx/core";

// ── DTMF pause mapping ──────────────────────────────────────────────────────
// Syrinx uses w=0.5s / W=1s (common telephony convention).
// Twilio <Play digits> / sendDigits: w=0.5s, W=1s (same).
// Telnyx send_dtmf: duration_millis per tone; pauses are separate `w`/`W` chars
//   in the digits string (Call Control accepts the same pause letters).

export interface TwilioSendDigitsCommand {
  readonly carrier: "twilio";
  readonly kind: "send_digits";
  /** REST Calls API path segment after /2010-04-01/Accounts/{AccountSid} */
  readonly path: string;
  readonly method: "POST";
  readonly form: {
    readonly SendDigits: string;
  };
  /** Equivalent TwiML fragment for a voice response webhook. */
  readonly twiml: string;
}

export interface TelnyxSendDtmfCommand {
  readonly carrier: "telnyx";
  readonly kind: "send_dtmf";
  readonly path: string;
  readonly method: "POST";
  readonly json: {
    readonly digits: string;
    readonly duration_millis?: number;
  };
}

export type SendDtmfCommand = TwilioSendDigitsCommand | TelnyxSendDtmfCommand;

/**
 * Twilio DTMF via Calls API `SendDigits` / TwiML `<Play digits="...">`.
 * Pause letters `w`/`W` pass through unchanged (Twilio's native pause syntax).
 * Live dispatch unverified.
 */
export function buildTwilioSendDigits(
  callSid: string,
  packet: Pick<DtmfSendPacket, "digits">,
): TwilioSendDigitsCommand {
  const digits = packet.digits;
  return {
    carrier: "twilio",
    kind: "send_digits",
    path: `/Calls/${encodeURIComponent(callSid)}.json`,
    method: "POST",
    form: { SendDigits: digits },
    twiml: `<Response><Play digits="${escapeXml(digits)}"/></Response>`,
  };
}

/**
 * Telnyx Call Control `send_dtmf`. Pause letters retained in the digits string.
 * Live dispatch unverified.
 */
export function buildTelnyxSendDtmf(
  callControlId: string,
  packet: Pick<DtmfSendPacket, "digits">,
  opts?: { readonly durationMillis?: number },
): TelnyxSendDtmfCommand {
  return {
    carrier: "telnyx",
    kind: "send_dtmf",
    path: `/v2/calls/${encodeURIComponent(callControlId)}/actions/send_dtmf`,
    method: "POST",
    json: {
      digits: packet.digits,
      ...(opts?.durationMillis !== undefined ? { duration_millis: opts.durationMillis } : {}),
    },
  };
}

// ── Transfer ────────────────────────────────────────────────────────────────

export interface TwilioTransferCommand {
  readonly carrier: "twilio";
  readonly kind: "transfer";
  readonly mode: CallTransferPacket["mode"];
  readonly path: string;
  readonly method: "POST";
  /**
   * Calls API redirect: set Url to a TwiML Bin / webhook that dials the target.
   * For cold/warm we emit the Dial TwiML the webhook would return.
   */
  readonly form: {
    readonly Url?: string;
    readonly Method?: "POST" | "GET";
    readonly Twiml?: string;
  };
  readonly twiml: string;
  /** Warm-handoff summary when mode is warm (not on the wire — for the receiving app). */
  readonly summary?: string;
}

export interface TelnyxTransferCommand {
  readonly carrier: "telnyx";
  readonly kind: "transfer";
  readonly mode: CallTransferPacket["mode"];
  readonly path: string;
  readonly method: "POST";
  readonly json: {
    readonly to: string;
    /** Prefer Call-Control transfer over SIP REFER (attestation B penalty). */
    readonly command_id?: string;
    readonly client_state?: string;
    readonly webhook_url?: string;
  };
  readonly summary?: string;
}

export type TransferCommand = TwilioTransferCommand | TelnyxTransferCommand;

/**
 * Twilio transfer via Calls API Twiml/Url redirect.
 * Prefer `<Dial>` (Call-Control style) over SIP REFER — REFER drops STIR/SHAKEN
 * attestation to B and hurts answer rate.
 * Live dispatch unverified.
 */
export function buildTwilioTransfer(
  callSid: string,
  packet: Pick<CallTransferPacket, "mode" | "target" | "summary">,
  opts?: { readonly redirectUrl?: string },
): TwilioTransferCommand {
  const twiml = twilioTransferTwiml(packet);
  return {
    carrier: "twilio",
    kind: "transfer",
    mode: packet.mode,
    path: `/Calls/${encodeURIComponent(callSid)}.json`,
    method: "POST",
    form: opts?.redirectUrl
      ? { Url: opts.redirectUrl, Method: "POST" }
      : { Twiml: twiml },
    twiml,
    ...(packet.summary !== undefined ? { summary: packet.summary } : {}),
  };
}

/**
 * Telnyx Call Control `transfer`. Prefer this over SIP REFER (mode sip_refer still
 * uses the transfer action with the SIP URI as `to` — Call Control, not raw REFER).
 * Live dispatch unverified.
 */
export function buildTelnyxTransfer(
  callControlId: string,
  packet: Pick<CallTransferPacket, "mode" | "target" | "summary">,
  opts?: { readonly webhookUrl?: string; readonly commandId?: string },
): TelnyxTransferCommand {
  // Warm summary is not a Telnyx wire field — surface via client_state so a
  // receiving reasoner-seam can recover it after the bridge.
  const clientState =
    packet.mode === "warm" && packet.summary
      ? base64UrlEncode(JSON.stringify({ summary: packet.summary, mode: "warm" }))
      : undefined;
  return {
    carrier: "telnyx",
    kind: "transfer",
    mode: packet.mode,
    path: `/v2/calls/${encodeURIComponent(callControlId)}/actions/transfer`,
    method: "POST",
    json: {
      to: packet.target,
      ...(opts?.commandId ? { command_id: opts.commandId } : {}),
      ...(clientState ? { client_state: clientState } : {}),
      ...(opts?.webhookUrl ? { webhook_url: opts.webhookUrl } : {}),
    },
    ...(packet.summary !== undefined ? { summary: packet.summary } : {}),
  };
}

function twilioTransferTwiml(packet: Pick<CallTransferPacket, "mode" | "target" | "summary">): string {
  // sip_refer still uses Dial — we deliberately avoid raw SIP REFER for answer-rate.
  const target = escapeXml(packet.target);
  if (packet.target.startsWith("sip:")) {
    return `<Response><Dial><Sip>${target}</Sip></Dial></Response>`;
  }
  const warmNote =
    packet.mode === "warm" && packet.summary
      ? `<!-- warm-handoff: ${escapeXml(packet.summary)} -->`
      : "";
  return `<Response>${warmNote}<Dial>${target}</Dial></Response>`;
}

// ── Injectable HTTP dispatch (fetch + injected creds) ───────────────────────

export interface TwilioRestCredentials {
  readonly accountSid: string;
  readonly authToken: string;
  /** Default https://api.twilio.com/2010-04-01/Accounts/{AccountSid} */
  readonly baseUrl?: string;
}

export interface TelnyxRestCredentials {
  readonly apiKey: string;
  /** Default https://api.telnyx.com */
  readonly baseUrl?: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Dispatch a Twilio form POST via global `fetch()`. Credentials injected —
 * never reads process.env (Workers-safe). Live call unverified.
 */
export async function dispatchTwilioCommand(
  creds: TwilioRestCredentials,
  command: TwilioSendDigitsCommand | TwilioTransferCommand,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
): Promise<Response> {
  const base =
    creds.baseUrl ??
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(creds.accountSid)}`;
  const url = `${base.replace(/\/$/, "")}${command.path}`;
  const body = new URLSearchParams(command.form as Record<string, string>).toString();
  const auth = basicAuth(creds.accountSid, creds.authToken);
  return fetchImpl(url, {
    method: command.method,
    headers: {
      Authorization: auth,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
}

/**
 * Dispatch a Telnyx Call Control JSON POST via global `fetch()`. Credentials
 * injected — never reads process.env (Workers-safe). Live call unverified.
 */
export async function dispatchTelnyxCommand(
  creds: TelnyxRestCredentials,
  command: TelnyxSendDtmfCommand | TelnyxTransferCommand,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
): Promise<Response> {
  const base = (creds.baseUrl ?? "https://api.telnyx.com").replace(/\/$/, "");
  const url = `${base}${command.path}`;
  return fetchImpl(url, {
    method: command.method,
    headers: {
      Authorization: `Bearer ${creds.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(command.json),
  });
}

// ── Warm-handoff summary seam ───────────────────────────────────────────────

/**
 * Injectable summarizer for warm transfer. The transport calls this when a
 * `call.transfer` packet has mode `"warm"` and no `summary` yet. Do NOT build
 * a bespoke LLM here — inject your reasoner/app hook.
 */
export type WarmTransferSummarizer = (args: {
  readonly contextId: string;
  readonly target: string;
}) => string | Promise<string | undefined> | undefined;

/** Resolve summary: packet.summary wins; else optional summarizer; else undefined. */
export async function resolveTransferSummary(
  packet: CallTransferPacket,
  summarizer?: WarmTransferSummarizer,
): Promise<string | undefined> {
  if (packet.summary !== undefined && packet.summary !== "") return packet.summary;
  if (packet.mode !== "warm" || !summarizer) return packet.summary;
  return summarizer({ contextId: packet.contextId, target: packet.target });
}

// ── helpers ─────────────────────────────────────────────────────────────────

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function basicAuth(user: string, pass: string): string {
  // btoa works on Workers + Node 18+; fall back to Buffer only if btoa missing
  // (should not happen on our targets — kept pure when btoa exists).
  const token = `${user}:${pass}`;
  if (typeof globalThis.btoa === "function") {
    return `Basic ${globalThis.btoa(token)}`;
  }
  const bytes = new TextEncoder().encode(token);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]!);
  // Minimal base64 without Buffer (Workers-safe path if btoa absent)
  return `Basic ${base64Encode(bin)}`;
}

function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]!);
  return base64Encode(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64Encode(binary: string): string {
  if (typeof globalThis.btoa === "function") return globalThis.btoa(binary);
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  let i = 0;
  while (i < binary.length) {
    const a = binary.charCodeAt(i++);
    const b = i < binary.length ? binary.charCodeAt(i++) : NaN;
    const c = i < binary.length ? binary.charCodeAt(i++) : NaN;
    const triplet = (a << 16) | ((Number.isNaN(b) ? 0 : b) << 8) | (Number.isNaN(c) ? 0 : c);
    out += chars[(triplet >> 18) & 63];
    out += chars[(triplet >> 12) & 63];
    out += Number.isNaN(b) ? "=" : chars[(triplet >> 6) & 63];
    out += Number.isNaN(c) ? "=" : chars[triplet & 63];
  }
  return out;
}
