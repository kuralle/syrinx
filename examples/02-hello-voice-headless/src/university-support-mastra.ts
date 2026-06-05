// SPDX-License-Identifier: MIT

import { createOpenAI } from "@ai-sdk/openai";
import { Agent } from "@mastra/core/agent";

import { VoiceAgentSession, type VoicePlugin } from "@asyncdot/voice";
import { ReasoningBridge } from "@asyncdot/voice-bridge-aisdk";
import { fromMastraAgent, type MastraAgentLike } from "@asyncdot/voice-bridge-mastra";
import { DeepgramSTTPlugin } from "@asyncdot/voice-stt-deepgram";
import { PipecatEOSPlugin } from "@asyncdot/voice-turn-pipecat";
import { CartesiaTTSPlugin } from "@asyncdot/voice-tts-cartesia";
import { GeminiTTSPlugin } from "@asyncdot/voice-tts-gemini";
import { DeepgramTTSPlugin } from "@asyncdot/voice-tts-deepgram";
import { SileroVADPlugin } from "@asyncdot/voice-vad-silero";

import { DEFAULT_MODEL } from "./run-one-turn.js";
import {
  UNIVERSITY_SUPPORT_SYSTEM_PROMPT,
  createUniversitySupportPluginConfig,
  type UniversitySupportSessionOptions,
  type UniversitySupportTtsProvider,
} from "./university-support-agent.js";

export type { UniversitySupportProfile, UniversitySupportSessionOptions, UniversitySupportTtsProvider } from "./university-support-agent.js";

export function createUniversitySupportMastraSession(options: UniversitySupportSessionOptions): VoiceAgentSession {
  const ttsProvider = options.ttsProvider ?? inferTtsProvider();
  const pluginConfig = createUniversitySupportPluginConfig({ ...options, ttsProvider });
  const session = new VoiceAgentSession({
    plugins: pluginConfig,
    idleTimeout: {
      durationMs: 30 * 60_000,
      maxConsecutive: 0,
      disconnectAfterMax: false,
    },
    sttForceFinalizeTimeoutMs: options.profile === "longform" ? 15_000 : 4_500,
    endpointingOwner: "smart_turn",
    latencyFillerEnabled: options.latencyFillerEnabled === true,
  });

  const openai = createOpenAI({ apiKey: requireEnv("OPENAI_API_KEY") });
  const mastraAgent = new Agent({
    id: "university-support",
    name: "university-support",
    instructions: UNIVERSITY_SUPPORT_SYSTEM_PROMPT,
    model: openai(process.env["SYRINX_LLM_MODEL"]?.trim() || DEFAULT_MODEL),
  });

  const plugins: Record<string, VoicePlugin> = {
    stt: new DeepgramSTTPlugin(),
    vad: new SileroVADPlugin(),
    eos: new PipecatEOSPlugin(),
    bridge: new ReasoningBridge(fromMastraAgent(mastraAgent as unknown as MastraAgentLike)),
    tts: createTtsPlugin(ttsProvider),
  };
  for (const [name, plugin] of Object.entries(plugins)) {
    session.registerPlugin(name, plugin);
  }
  return session;
}

function createTtsPlugin(provider: UniversitySupportTtsProvider): VoicePlugin {
  switch (provider) {
    case "cartesia":
      return new CartesiaTTSPlugin();
    case "deepgram":
      return new DeepgramTTSPlugin();
    case "gemini":
      return new GeminiTTSPlugin();
  }
}

function inferTtsProvider(): UniversitySupportTtsProvider {
  const requested = process.env["SYRINX_REVIEW_TTS"]?.trim().toLowerCase();
  if (requested === "gemini" || requested === "cartesia" || requested === "deepgram") return requested;
  return process.env["CARTESIA_API_KEY"]?.trim() ? "cartesia" : "gemini";
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
