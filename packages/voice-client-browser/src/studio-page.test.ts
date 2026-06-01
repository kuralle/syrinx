// SPDX-License-Identifier: MIT

// Guards the standalone studio page (packages/voice-client-browser/index.html), which is
// served raw by the review studio. Its assistant-audio decoder is PCM16-only (no Opus
// decoder), so it must declare a pcm_s16le downlink capability on connect — otherwise the
// server streams Opus envelopes it rejects with "PCM16 payload must contain an even number
// of bytes" / "durationMs mismatch". Regression guard for that contract.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const html = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");

describe("studio index.html downlink codec negotiation", () => {
  it("declares pcm_s16le downlink capability on connect", () => {
    // The page has no Opus decoder, so it must negotiate PCM downlink.
    expect(html).not.toMatch(/OpusDecoder|decodeOpus/);
    const open = html.slice(html.indexOf('addEventListener("open"'), html.indexOf('addEventListener("close"'));
    expect(open).toMatch(/"codec_capability"/);
    expect(open).toMatch(/downlinkEncoding:\s*"pcm_s16le"/);
  });
});
