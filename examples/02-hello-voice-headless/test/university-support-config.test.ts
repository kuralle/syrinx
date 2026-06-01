// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { createUniversitySupportPluginConfig } from "../src/university-support-agent.js";

describe("university support interactive endpointing config", () => {
  it("keeps browser-interactive endpointing semantic and non-VAD-finalizing", () => {
    process.env["DEEPGRAM_API_KEY"] = "test-deepgram";
    process.env["GOOGLE_GENERATIVE_AI_API_KEY"] = "test-google";
    const config = createUniversitySupportPluginConfig({
      inputSampleRate: 16000,
      profile: "interactive",
      ttsProvider: "gemini",
    });

    expect(config["vad"]).toMatchObject({
      min_silence_duration_ms: 650,
      speech_pad_ms: 180,
    });
    expect(config["eos"]).toMatchObject({
      finalize_delay_ms: 450,
      incomplete_fallback_ms: 3200,
      semantic_shortcut_delay_ms: 0,
      semantic_defer_fallback_ms: 4500,
    });
    expect(config["eos"]).not.toHaveProperty("raw_vad_silence_finalize_ms");
  });
});
