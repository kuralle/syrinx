// SPDX-License-Identifier: MIT
//
// Unit tests for pure carrier command constructors + mockable dispatch.
// Live carrier HTTP is NOT exercised (no credentials).

import { describe, expect, it, vi } from "vitest";
import {
  buildTelnyxSendDtmf,
  buildTelnyxTransfer,
  buildTwilioSendDigits,
  buildTwilioTransfer,
  dispatchTelnyxCommand,
  dispatchTwilioCommand,
  resolveTransferSummary,
  type FetchLike,
} from "./carrier-commands.js";

describe("buildTwilioSendDigits", () => {
  it("maps digits + pause syntax into SendDigits and TwiML Play", () => {
    const cmd = buildTwilioSendDigits("CAxxx", { digits: "1w2W9*#" });
    expect(cmd.carrier).toBe("twilio");
    expect(cmd.path).toBe("/Calls/CAxxx.json");
    expect(cmd.form.SendDigits).toBe("1w2W9*#");
    expect(cmd.twiml).toBe('<Response><Play digits="1w2W9*#"/></Response>');
  });

  it("URL-encodes call SID in the path", () => {
    const cmd = buildTwilioSendDigits("CA/special", { digits: "0" });
    expect(cmd.path).toBe("/Calls/CA%2Fspecial.json");
  });
});

describe("buildTelnyxSendDtmf", () => {
  it("builds Call Control send_dtmf payload with pause letters retained", () => {
    const cmd = buildTelnyxSendDtmf("v3:abc", { digits: "9w0W#" }, { durationMillis: 250 });
    expect(cmd.carrier).toBe("telnyx");
    expect(cmd.path).toBe("/v2/calls/v3%3Aabc/actions/send_dtmf");
    expect(cmd.json).toEqual({ digits: "9w0W#", duration_millis: 250 });
  });
});

describe("buildTwilioTransfer", () => {
  it("cold transfer emits Dial TwiML for E.164", () => {
    const cmd = buildTwilioTransfer("CAcall", {
      mode: "cold",
      target: "+15551234567",
    });
    expect(cmd.twiml).toBe("<Response><Dial>+15551234567</Dial></Response>");
    expect(cmd.form.Twiml).toContain("<Dial>");
  });

  it("warm transfer carries summary in a TwiML comment and command field", () => {
    const cmd = buildTwilioTransfer("CAcall", {
      mode: "warm",
      target: "+15557654321",
      summary: "Caller asked about billing",
    });
    expect(cmd.summary).toBe("Caller asked about billing");
    expect(cmd.twiml).toContain("<!-- warm-handoff: Caller asked about billing -->");
    expect(cmd.twiml).toContain("<Dial>+15557654321</Dial>");
  });

  it("sip_refer still uses Dial/Sip (not raw REFER) for answer-rate", () => {
    const cmd = buildTwilioTransfer("CAcall", {
      mode: "sip_refer",
      target: "sip:agent@example.com",
    });
    expect(cmd.twiml).toBe("<Response><Dial><Sip>sip:agent@example.com</Sip></Dial></Response>");
  });

  it("redirectUrl mode posts Url instead of inline Twiml", () => {
    const cmd = buildTwilioTransfer(
      "CAcall",
      { mode: "cold", target: "+15550001111" },
      { redirectUrl: "https://example.com/twiml" },
    );
    expect(cmd.form).toEqual({ Url: "https://example.com/twiml", Method: "POST" });
  });
});

describe("buildTelnyxTransfer", () => {
  it("cold transfer posts to Call Control transfer action", () => {
    const cmd = buildTelnyxTransfer("v3:id", { mode: "cold", target: "+15551234567" });
    expect(cmd.path).toBe("/v2/calls/v3%3Aid/actions/transfer");
    expect(cmd.json.to).toBe("+15551234567");
    expect(cmd.json.client_state).toBeUndefined();
  });

  it("warm transfer encodes summary into client_state", () => {
    const cmd = buildTelnyxTransfer("v3:id", {
      mode: "warm",
      target: "+15550001111",
      summary: "Needs refund help",
    });
    expect(cmd.summary).toBe("Needs refund help");
    expect(cmd.json.client_state).toBeTypeOf("string");
    const raw = cmd.json.client_state!;
    // base64url → standard base64 with correct padding
    let b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4 !== 0) b64 += "=";
    const json = JSON.parse(atob(b64)) as { summary: string; mode: string };
    expect(json).toEqual({ summary: "Needs refund help", mode: "warm" });
  });

  it("sip_refer mode still uses transfer action with SIP URI as to", () => {
    const cmd = buildTelnyxTransfer("v3:id", {
      mode: "sip_refer",
      target: "sip:desk@pbx.example",
    });
    expect(cmd.path).toContain("/actions/transfer");
    expect(cmd.json.to).toBe("sip:desk@pbx.example");
  });
});

describe("resolveTransferSummary (warm seam)", () => {
  it("uses packet.summary when provided", async () => {
    const summary = await resolveTransferSummary({
      kind: "call.transfer",
      contextId: "c1",
      timestampMs: 1,
      mode: "warm",
      target: "+1",
      summary: "from packet",
    });
    expect(summary).toBe("from packet");
  });

  it("calls injectable summarizer when warm and summary missing", async () => {
    const summarizer = vi.fn(async () => "from seam");
    const summary = await resolveTransferSummary(
      {
        kind: "call.transfer",
        contextId: "c1",
        timestampMs: 1,
        mode: "warm",
        target: "+1555",
      },
      summarizer,
    );
    expect(summarizer).toHaveBeenCalledWith({ contextId: "c1", target: "+1555" });
    expect(summary).toBe("from seam");
  });

  it("does not call summarizer for cold transfer", async () => {
    const summarizer = vi.fn(async () => "nope");
    const summary = await resolveTransferSummary(
      {
        kind: "call.transfer",
        contextId: "c1",
        timestampMs: 1,
        mode: "cold",
        target: "+1555",
      },
      summarizer,
    );
    expect(summarizer).not.toHaveBeenCalled();
    expect(summary).toBeUndefined();
  });
});

describe("dispatch via fetch (mockable, no live carrier)", () => {
  it("dispatchTwilioCommand posts form body with Basic auth", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    };
    const cmd = buildTwilioSendDigits("CAsid", { digits: "12" });
    await dispatchTwilioCommand(
      { accountSid: "ACacct", authToken: "secret" },
      cmd,
      fetchImpl,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/2010-04-01/Accounts/ACacct/Calls/CAsid.json");
    expect(calls[0]!.init?.method).toBe("POST");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Basic /);
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(calls[0]!.init?.body).toBe("SendDigits=12");
  });

  it("dispatchTelnyxCommand posts JSON with Bearer auth", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    };
    const cmd = buildTelnyxTransfer("v3:x", { mode: "cold", target: "+1555" });
    await dispatchTelnyxCommand({ apiKey: "KEY" }, cmd, fetchImpl);
    expect(calls[0]!.url).toBe("https://api.telnyx.com/v2/calls/v3%3Ax/actions/transfer");
    expect(calls[0]!.init?.headers).toMatchObject({
      Authorization: "Bearer KEY",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ to: "+1555" });
  });
});
