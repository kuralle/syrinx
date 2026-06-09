// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from "vitest";

import { createGeminiTranslateSession } from "./gemini-translate.js";

const sendRealtimeInput = vi.fn();
const closeSession = vi.fn();

const liveConnect = vi.fn().mockImplementation(async () => ({
  sendRealtimeInput,
  close: closeSession,
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    live: { connect: liveConnect },
  })),
  Modality: { AUDIO: "AUDIO" },
}));

const FRAME_BYTES = 640;

function frame(byte: number): Uint8Array {
  return new Uint8Array(FRAME_BYTES).fill(byte);
}

afterEach(() => {
  sendRealtimeInput.mockClear();
  closeSession.mockClear();
  liveConnect.mockClear();
});

describe("createGeminiTranslateSession", () => {
  it("coalesces 20ms frames into 100ms chunks before sendRealtimeInput", async () => {
    const session = await createGeminiTranslateSession({
      apiKey: "test-key",
      targetLanguageCode: "es",
      onAudio: () => {},
    });

    for (let i = 0; i < 5; i += 1) {
      session.sendAudio(frame(i));
    }

    expect(sendRealtimeInput).toHaveBeenCalledTimes(1);
    const arg = sendRealtimeInput.mock.calls[0]![0] as { audio: { data: string } };
    const chunk = Buffer.from(arg.audio.data, "base64");
    expect(chunk.byteLength).toBe(3200);
    expect(chunk[0]).toBe(0);
    expect(chunk[639]).toBe(0);
    expect(chunk[640]).toBe(1);
    expect(chunk[3199]).toBe(4);
  });

  it("flushes remainder on signalAudioStreamEnd and close", async () => {
    const session = await createGeminiTranslateSession({
      apiKey: "test-key",
      targetLanguageCode: "es",
      onAudio: () => {},
    });

    session.sendAudio(frame(9));
    session.sendAudio(frame(9));
    session.sendAudio(frame(9));
    expect(sendRealtimeInput).toHaveBeenCalledTimes(0);

    session.signalAudioStreamEnd();
    expect(sendRealtimeInput).toHaveBeenCalledTimes(2);
    const streamEndArg = sendRealtimeInput.mock.calls[0]![0] as { audio: { data: string } };
    expect(Buffer.from(streamEndArg.audio.data, "base64").byteLength).toBe(1920);
    expect(sendRealtimeInput.mock.calls[1]![0]).toEqual({ audioStreamEnd: true });

    sendRealtimeInput.mockClear();
    session.sendAudio(frame(7));
    await session.close();
    expect(sendRealtimeInput).toHaveBeenCalledTimes(1);
    const closeArg = sendRealtimeInput.mock.calls[0]![0] as { audio: { data: string } };
    expect(Buffer.from(closeArg.audio.data, "base64").byteLength).toBe(640);
    expect(closeSession).toHaveBeenCalledTimes(1);
  });
});
