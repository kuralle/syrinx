// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PipelineBusImpl,
  Route,
  type TextToSpeechAudioPacket,
  type TtsErrorPacket,
} from "@asyncdot/voice";
import { GeminiTTSPlugin } from "./index.js";

const generateContent = vi.fn();

vi.mock("@google/genai", () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    models: { generateContent },
  })),
}));

afterEach(() => {
  generateContent.mockReset();
});

describe("GeminiTTSPlugin", () => {
  it("emits tts.error for odd-length PCM16 without throwing into the bus pump", async () => {
    generateContent.mockResolvedValue({
      candidates: [{
        content: {
          parts: [{
            inlineData: {
              mimeType: "audio/pcm",
              data: Buffer.from(new Uint8Array([1, 2, 3])).toString("base64"),
            },
          }],
        },
      }],
    });

    const bus = new PipelineBusImpl();
    const started = bus.start();
    const plugin = new GeminiTTSPlugin();
    const audio: TextToSpeechAudioPacket[] = [];
    const errors: TtsErrorPacket[] = [];
    bus.on("tts.audio", (pkt) => {
      audio.push(pkt as TextToSpeechAudioPacket);
    });
    bus.on("tts.error", (pkt) => {
      errors.push(pkt as TtsErrorPacket);
    });

    await plugin.initialize(bus, { api_key: "test-gemini-key" });
    bus.push(Route.Main, {
      kind: "tts.done",
      contextId: "turn-odd-pcm",
      timestampMs: Date.now(),
      text: "Hello.",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(audio).toEqual([]);
    expect(errors).toEqual([
      expect.objectContaining({
        kind: "tts.error",
        contextId: "turn-odd-pcm",
        component: "tts",
        cause: expect.objectContaining({
          message: expect.stringMatching(/even number of bytes/i),
        }),
      }),
    ]);

    await plugin.close();
    bus.stop();
    await started;
  });
});
