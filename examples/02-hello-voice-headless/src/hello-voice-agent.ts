// SPDX-License-Identifier: MIT
//
// Minimal cascade voice agent — the runnable version of the "Building a voice agent"
// docs guide. Deepgram STT -> an AI SDK reasoner -> Cartesia TTS, with Deepgram
// owning endpointing. Feed it audio via a transport (browser or telephony) and it
// speaks back. See docs: /guides/building-a-voice-agent

import { VoiceAgentSession, type VoicePlugin } from "@kuralle-syrinx/core";
import { DeepgramSTTPlugin } from "@kuralle-syrinx/deepgram";
import { CartesiaTTSPlugin } from "@kuralle-syrinx/cartesia";
import { ReasoningBridge, fromStreamText } from "@kuralle-syrinx/aisdk";
import { createOpenAI } from "@ai-sdk/openai";

export function createHelloVoiceAgent(): VoiceAgentSession {
  const openai = createOpenAI({ apiKey: process.env["OPENAI_API_KEY"] });

  // Per-slot config (API keys, model, voice) goes in the constructor.
  const session = new VoiceAgentSession({
    plugins: {
      stt: {
        api_key: process.env["DEEPGRAM_API_KEY"] ?? "",
        model: "nova-3",
        sample_rate: 16000,
        emit_eos_on_final: true,
      },
      bridge: {},
      tts: {
        api_key: process.env["CARTESIA_API_KEY"] ?? "",
        voice_id: process.env["CARTESIA_VOICE_ID"] ?? "",
      },
    },
    endpointingOwner: "provider_stt",
  });

  // The plugin instances are registered by slot: stt, the reasoner bridge, and tts.
  const plugins: Record<string, VoicePlugin> = {
    stt: new DeepgramSTTPlugin(),
    bridge: new ReasoningBridge(
      fromStreamText({
        model: openai("gpt-4.1-mini"),
        system: "You are a helpful voice assistant. Keep your replies short.",
      }),
    ),
    tts: new CartesiaTTSPlugin(),
  };
  for (const [name, plugin] of Object.entries(plugins)) {
    session.registerPlugin(name, plugin);
  }

  return session;
}
