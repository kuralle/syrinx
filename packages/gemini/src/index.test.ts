// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PipelineBusImpl,
  Route,
  type TextToSpeechAudioPacket,
  type TtsErrorPacket,
} from "@kuralle-syrinx/core";
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

  it("sends the raw text to Gemini by default (no hardcoded persona lead-in)", async () => {
    generateContent.mockResolvedValue({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/pcm", data: Buffer.from(new Uint8Array([1, 2, 3, 4])).toString("base64") } }] } }],
    });
    const bus = new PipelineBusImpl();
    const started = bus.start();
    const plugin = new GeminiTTSPlugin();
    await plugin.initialize(bus, { api_key: "test-gemini-key" });
    bus.push(Route.Main, { kind: "tts.done", contextId: "t1", timestampMs: Date.now(), text: "Add Biology 101." });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(generateContent).toHaveBeenCalledTimes(1);
    const arg = generateContent.mock.calls[0]![0] as { contents: Array<{ parts: Array<{ text: string }> }> };
    expect(arg.contents[0]!.parts[0]!.text).toBe("Add Biology 101.");

    await plugin.close();
    bus.stop();
    await started;
  });

  it("prepends a configured instruction lead-in when provided", async () => {
    generateContent.mockResolvedValue({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/pcm", data: Buffer.from(new Uint8Array([1, 2, 3, 4])).toString("base64") } }] } }],
    });
    const bus = new PipelineBusImpl();
    const started = bus.start();
    const plugin = new GeminiTTSPlugin();
    await plugin.initialize(bus, { api_key: "test-gemini-key", instruction: "Read aloud warmly" });
    bus.push(Route.Main, { kind: "tts.done", contextId: "t2", timestampMs: Date.now(), text: "Hi." });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const arg = generateContent.mock.calls[0]![0] as { contents: Array<{ parts: Array<{ text: string }> }> };
    expect(arg.contents[0]!.parts[0]!.text).toBe("Read aloud warmly: Hi.");

    await plugin.close();
    bus.stop();
    await started;
  });
});
