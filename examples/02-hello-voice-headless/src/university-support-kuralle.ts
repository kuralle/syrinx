// SPDX-License-Identifier: MIT

import { createOpenAI } from "@ai-sdk/openai";
import { defineAgent, createRuntime, MemoryStore } from "@kuralle-agents/core";

import { VoiceAgentSession, type VoicePlugin } from "@kuralle-syrinx/core";
import { ReasoningBridge } from "@kuralle-syrinx/aisdk";
import { DeepgramSTTPlugin } from "@kuralle-syrinx/deepgram";
import { PipecatEOSPlugin } from "@kuralle-syrinx/pipecat-smart-turn";
import { CartesiaTTSPlugin } from "@kuralle-syrinx/cartesia";
import { GeminiTTSPlugin } from "@kuralle-syrinx/gemini";
import { DeepgramTTSPlugin } from "@kuralle-syrinx/deepgram";
import { SileroVADPlugin } from "@kuralle-syrinx/silero-vad";

import { DEFAULT_MODEL } from "./run-one-turn.js";
import { fromKuralleRuntime, type KuralleRuntimeLike } from "@kuralle-syrinx/kuralle";
import {
  UNIVERSITY_SUPPORT_SYSTEM_PROMPT,
  createUniversitySupportPluginConfig,
  type UniversitySupportSessionOptions,
  type UniversitySupportTtsProvider,
} from "./university-support-agent.js";

export type { UniversitySupportProfile, UniversitySupportSessionOptions, UniversitySupportTtsProvider } from "./university-support-agent.js";

export interface UniversitySupportKuralleSessionOptions extends UniversitySupportSessionOptions {
  readonly sessionId: string;
  readonly userId?: string;
}

export function createUniversitySupportKuralleSession(
  options: UniversitySupportKuralleSessionOptions,
): VoiceAgentSession {
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
  const runtime = createRuntime({
    agents: [
      defineAgent({
        id: "university",
        model: openai(process.env["SYRINX_LLM_MODEL"]?.trim() || DEFAULT_MODEL),
        instructions: UNIVERSITY_SUPPORT_SYSTEM_PROMPT,
        memory: { workingMemory: { autoLoad: [{ scope: "user", key: "USER" }] } },
      }),
    ],
    defaultAgentId: "university",
    sessionStore: new MemoryStore(),
  });

  const bridge = new ReasoningBridge(
    fromKuralleRuntime(runtime as unknown as KuralleRuntimeLike, {
      sessionId: options.sessionId,
      userId: options.userId,
    }),
  );

  const plugins: Record<string, VoicePlugin> = {
    stt: new DeepgramSTTPlugin(),
    vad: new SileroVADPlugin(),
    eos: new PipecatEOSPlugin(),
    bridge,
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
