// SPDX-License-Identifier: MIT
//
// Twilio request-signature validation (X-Twilio-Signature). Runtime-neutral —
// uses Web Crypto (HMAC-SHA1), so it works on Node and Cloudflare Workers. Twilio
// signs each webhook: signature = base64(HMAC-SHA1(authToken, fullUrl + concat of
// POST params sorted by key, each as key+value)). Reference:
// https://www.twilio.com/docs/usage/security#validating-requests
//
// Plug into the transport `authorize` hook, or call directly in a webhook handler.

/**
 * Validate a Twilio request signature. `params` are the POST form fields (empty
 * for a bare GET / WS upgrade). Constant-time compares the computed signature
 * against the provided one. Returns false on any mismatch or malformed input.
 */
export async function validateTwilioSignature(args: {
  readonly authToken: string;
  readonly signature: string | null | undefined;
  readonly url: string;
  readonly params?: Record<string, string>;
}): Promise<boolean> {
  const { authToken, signature, url } = args;
  if (!authToken || !signature) return false;

  const params = args.params ?? {};
  let data = url;
  for (const key of Object.keys(params).sort()) {
    data += key + params[key];
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const expected = base64FromBytes(new Uint8Array(mac));
  return timingSafeEqual(expected, signature);
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  // btoa exists on Workers and modern Node globals.
  return btoa(binary);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
