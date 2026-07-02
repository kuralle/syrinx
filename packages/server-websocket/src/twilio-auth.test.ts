// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { validateTwilioSignature } from "./twilio-auth.js";

// Vector computed with the canonical HMAC-SHA1 algorithm (verified against
// node:crypto createHmac("sha1")) for these exact inputs — this pins that our
// Web Crypto implementation matches Twilio's documented signing scheme.
describe("validateTwilioSignature", () => {
  const authToken = "12345";
  const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
  const params = {
    CallSid: "CA1234567890ABCDE",
    Caller: "+14158675310",
    Digits: "1234",
    From: "+14158675310",
    To: "+18005551212",
  };
  const validSignature = "GvWf1cFY/Q7PnoempGyD5oXAezc=";

  it("accepts a correct signature", async () => {
    expect(await validateTwilioSignature({ authToken, signature: validSignature, url, params })).toBe(true);
  });

  it("rejects a tampered signature", async () => {
    expect(await validateTwilioSignature({ authToken, signature: "AAAA" + validSignature.slice(4), url, params })).toBe(false);
  });

  it("rejects a wrong auth token", async () => {
    expect(await validateTwilioSignature({ authToken: "wrong", signature: validSignature, url, params })).toBe(false);
  });

  it("rejects a missing signature", async () => {
    expect(await validateTwilioSignature({ authToken, signature: null, url, params })).toBe(false);
  });
});
