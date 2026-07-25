// SPDX-License-Identifier: MIT
//
// TTS stage registry, verified against packages/{cartesia,elevenlabs,gemini,openai-tts,grok}/src.

import type { TtsProvider } from "../options.js";
import type { StageProvider } from "./types.js";

const PKG_VERSION = "^4.3.0";

export const TTS_STAGE_PROVIDERS: Readonly<Record<TtsProvider, StageProvider | undefined>> = {
  // packages/cartesia/src/index.ts: CartesiaTTSPlugin. Config mirrors hello-voice-agent.ts.
  cartesia: {
    packageName: "@kuralle-syrinx/cartesia",
    packageVersion: PKG_VERSION,
    className: "CartesiaTTSPlugin",
    envKeys: [
      { key: "CARTESIA_API_KEY", required: true },
      { key: "CARTESIA_VOICE_ID", required: true },
    ],
    usesSocketFactory: true,
    ownsEndpointing: false,
    configFields: (envRef) => [`api_key: ${envRef("CARTESIA_API_KEY")}`, `voice_id: ${envRef("CARTESIA_VOICE_ID")}`],
  },
  // packages/elevenlabs/src/tts.ts: ElevenLabsTTSPlugin.
  elevenlabs: {
    packageName: "@kuralle-syrinx/elevenlabs",
    packageVersion: PKG_VERSION,
    importFrom: "@kuralle-syrinx/elevenlabs/tts",
    className: "ElevenLabsTTSPlugin",
    envKeys: [
      { key: "ELEVENLABS_API_KEY", required: true },
      { key: "ELEVENLABS_VOICE_ID", required: true },
    ],
    usesSocketFactory: true,
    ownsEndpointing: false,
    configFields: (envRef) => [`api_key: ${envRef("ELEVENLABS_API_KEY")}`, `voice_id: ${envRef("ELEVENLABS_VOICE_ID")}`],
  },
  // packages/gemini/src/index.ts: GeminiTTSPlugin. HTTP-based (@google/genai) — no SocketFactory.
  gemini: {
    packageName: "@kuralle-syrinx/gemini",
    packageVersion: PKG_VERSION,
    className: "GeminiTTSPlugin",
    envKeys: [{ key: "GOOGLE_GENERATIVE_AI_API_KEY", required: true }],
    usesSocketFactory: false,
    ownsEndpointing: false,
    configFields: (envRef) => [`api_key: ${envRef("GOOGLE_GENERATIVE_AI_API_KEY")}`],
  },
  // packages/openai-tts/src/index.ts: OpenAICompatibleTTSPlugin. HTTP-based — no SocketFactory.
  "openai-tts": {
    packageName: "@kuralle-syrinx/openai-tts",
    packageVersion: PKG_VERSION,
    className: "OpenAICompatibleTTSPlugin",
    envKeys: [{ key: "OPENAI_API_KEY", required: true }],
    usesSocketFactory: false,
    ownsEndpointing: false,
    configFields: (envRef) => [`api_key: ${envRef("OPENAI_API_KEY")}`],
  },
  // packages/grok/src/tts.ts: GrokTTSPlugin.
  grok: {
    packageName: "@kuralle-syrinx/grok",
    packageVersion: PKG_VERSION,
    importFrom: "@kuralle-syrinx/grok/tts",
    className: "GrokTTSPlugin",
    envKeys: [{ key: "XAI_API_KEY", required: true }],
    usesSocketFactory: true,
    ownsEndpointing: false,
    configFields: (envRef) => [`api_key: ${envRef("XAI_API_KEY")}`, `voice_id: "eve"`],
  },
};
