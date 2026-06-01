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

  it("rejects a non-pcm_s16le downlink encoding loudly instead of failing as cryptic PCM", () => {
    // If the server ever sends a non-PCM envelope (codec negotiation failure), the decoder
    // must branch on metadata.encoding and surface a clear error — not the misleading
    // "PCM16 payload must contain an even number of bytes" the byte invariants would throw.
    const decode = html.slice(html.indexOf("function decodeAssistantAudio"), html.indexOf("function hasPrefix"));
    expect(decode).toMatch(/metadata\.encoding\s*&&\s*metadata\.encoding\s*!==\s*"pcm_s16le"/);
  });
});

describe("studio index.html capture turn lifecycle", () => {
  it("keeps the capture context open across VAD speech_ended until the server commits the turn", () => {
    const speechEnded = html.slice(
      html.indexOf('message.type === "speech_ended"'),
      html.indexOf('message.type === "audio_clear"'),
    );
    expect(speechEnded).toMatch(/drainPcmQueue\(turn\.id\)/);
    expect(speechEnded).not.toMatch(/activeTurn\s*=\s*null/);

    const turnComplete = html.slice(
      html.indexOf('message.type === "turn_complete"'),
      html.indexOf('message.type === "agent_tool_call"'),
    );
    expect(turnComplete).toMatch(/activeTurn\?\.id\s*===\s*turn\.id/);
    expect(turnComplete).toMatch(/activeTurn\s*=\s*null/);
  });
});

describe("studio index.html local speech-start barge-in", () => {
  it("flushes local assistant playout before sending a server client_interrupt", () => {
    const handler = html.slice(
      html.indexOf("function handleLocalSpeechStart"),
      html.indexOf("function createCaptureTurn"),
    );
    expect(handler).toMatch(/flushOutputAudio\(\)[\s\S]*sendClientInterrupt/);
    expect(handler).toMatch(/local_vad_speech_start/);
  });

  it("does not use browser speech_ended or silence as an EOS signal", () => {
    const capture = html.slice(
      html.indexOf("processorNode.onaudioprocess"),
      html.indexOf("sourceNode.connect"),
    );
    expect(capture).toMatch(/handleLocalSpeechStart/);
    expect(capture).not.toMatch(/eos\.turn_complete|turn_complete|client_eos|speech_ended/);
  });
});
