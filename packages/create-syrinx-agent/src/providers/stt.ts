// SPDX-License-Identifier: MIT
//
// STT stage registry, verified against packages/{deepgram,google,elevenlabs,grok}/src.
// `undefined` for a provider not yet wired into the generator.

import type { SttProvider } from "../options.js";
import type { StageProvider } from "./types.js";

const PKG_VERSION = "^4.3.0";

export const STT_STAGE_PROVIDERS: Readonly<Record<SttProvider, StageProvider | undefined>> = {
  // packages/deepgram/src/stt.ts: DeepgramSTTPlugin, endpointingCapability.owner === "provider_stt".
  // Config fields mirror examples/02-hello-voice-headless/src/hello-voice-agent.ts.
  deepgram: {
    packageName: "@kuralle-syrinx/deepgram",
    packageVersion: PKG_VERSION,
    className: "DeepgramSTTPlugin",
    envKeys: [{ key: "DEEPGRAM_API_KEY", required: true }],
    usesSocketFactory: true,
    ownsEndpointing: true,
    configFields: (envRef) => [
      `api_key: ${envRef("DEEPGRAM_API_KEY")}`,
      `model: "nova-3"`,
      `sample_rate: 16000`,
      `emit_eos_on_final: true`,
    ],
  },
  // packages/google/src/index.ts: GoogleSTTPlugin (Cloud Speech-to-Text v2).
  // api_key + project_id are required config; endpointingCapability.owner === "provider_stt".
  google: {
    packageName: "@kuralle-syrinx/google",
    packageVersion: PKG_VERSION,
    className: "GoogleSTTPlugin",
    envKeys: [
      { key: "GOOGLE_CLOUD_SPEECH_API_KEY", required: true },
      { key: "GOOGLE_CLOUD_PROJECT_ID", required: true },
    ],
    usesSocketFactory: true,
    ownsEndpointing: true,
    configFields: (envRef) => [
      `api_key: ${envRef("GOOGLE_CLOUD_SPEECH_API_KEY")}`,
      `project_id: ${envRef("GOOGLE_CLOUD_PROJECT_ID")}`,
      `sample_rate: 16000`,
    ],
  },
  // packages/elevenlabs/src/stt.ts: ElevenLabsSTTPlugin (Scribe v2 Realtime).
  elevenlabs: {
    packageName: "@kuralle-syrinx/elevenlabs",
    packageVersion: PKG_VERSION,
    importFrom: "@kuralle-syrinx/elevenlabs/stt",
    className: "ElevenLabsSTTPlugin",
    envKeys: [{ key: "ELEVENLABS_API_KEY", required: true }],
    usesSocketFactory: true,
    ownsEndpointing: true,
    configFields: (envRef) => [`api_key: ${envRef("ELEVENLABS_API_KEY")}`],
  },
  // packages/grok/src/stt.ts: GrokSTTPlugin. endpointingCapability.owner === "provider_stt".
  grok: {
    packageName: "@kuralle-syrinx/grok",
    packageVersion: PKG_VERSION,
    importFrom: "@kuralle-syrinx/grok/stt",
    className: "GrokSTTPlugin",
    envKeys: [{ key: "XAI_API_KEY", required: true }],
    usesSocketFactory: true,
    ownsEndpointing: true,
    configFields: (envRef) => [`api_key: ${envRef("XAI_API_KEY")}`, `language: "en"`],
  },
};
