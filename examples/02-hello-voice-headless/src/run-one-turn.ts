// SPDX-License-Identifier: MIT
//
// This example's default kernel: Deepgram STT + SileroVAD + an OpenAI-backed
// ReasoningBridge + Cartesia TTS. Hardcoded providers are legitimate HERE —
// this is a demo harness, not a shipped package — but the mechanics of
// actually driving a turn (feed audio, capture the transcript/reply/timings,
// write artifacts) must not be duplicated. That part moved to
// @kuralle-syrinx/cli's `driveTurn` (LDT-20): this file builds the session,
// `driveTurn` runs it. There is exactly one implementation of "run a turn".

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";
import { createOpenAI } from "@ai-sdk/openai";
import { stepCountIs } from "ai";
import {
  VoiceAgentSession,
  type PluginConfig,
  type VoicePlugin,
} from "@kuralle-syrinx/core";
import { ReasoningBridge, fromStreamText } from "@kuralle-syrinx/aisdk";
import { DeepgramSTTPlugin } from "@kuralle-syrinx/deepgram";
import { CartesiaTTSPlugin } from "@kuralle-syrinx/cartesia";
import { SileroVADPlugin } from "@kuralle-syrinx/silero-vad";

import { driveTurn, readPcm16Mono16kWav, type PerTurnMetrics, type TurnResult } from "@kuralle-syrinx/cli/turn-runner";

export const DEFAULT_MODEL = "gpt-4.1-mini";

const DEFAULT_VOICE_ID =
  typeof process.env["CARTESIA_VOICE_ID"] === "string" &&
  process.env["CARTESIA_VOICE_ID"].trim().length > 0
    ? process.env["CARTESIA_VOICE_ID"].trim()
    : "694f9389-aac1-45b6-b726-9d9369183238";

const DEFAULT_SYSTEM_LINES = [
  "You are a helpful voice assistant.",
  "Respond clearly and succinctly.",
] as const;

export interface HeadlessSessionOptions {
  readonly plugins: Record<string, VoicePlugin>;
  readonly pluginConfig: Record<string, PluginConfig>;
  readonly sttForceFinalizeTimeoutMs?: number;
}

export interface RunOneTurnOptions {
  readonly inputWavPath: string;
  readonly sessionDir: string;
  readonly model?: string;
  readonly voiceId?: string;
  readonly systemPrompt?: string;
}

export interface ExtendedRunOneTurnOptions extends RunOneTurnOptions {
  readonly sessionOverrides?: HeadlessSessionOptions;
  /** Skips WAV read; must be mono 16 kHz PCM decoded samples. */
  readonly syntheticMono16kSamples?: Readonly<Int16Array>;
  readonly realtimePacing?: boolean;
}

export type { PerTurnMetrics, TurnResult };
export { readPcm16Mono16kWav };

let envLoadedFromRoot = false;

export function ensureRepoRootDotenv(): void {
  if (envLoadedFromRoot) return;
  envLoadedFromRoot = true;
  const hereDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(hereDir, "../../..");
  loadDotenv({ path: resolve(repoRoot, ".env") });
}

export function coerceGoogleGenAiKey(): void {
  if (
    !process.env["GOOGLE_GENERATIVE_AI_API_KEY"] &&
    typeof process.env["GEMINI_API_KEY"] === "string" &&
    process.env["GEMINI_API_KEY"].length > 0
  ) {
    process.env["GOOGLE_GENERATIVE_AI_API_KEY"] = process.env["GEMINI_API_KEY"];
  }
}

export function listMissingVoiceHeadlessEnvKeys(): string[] {
  const missing: string[] = [];
  if (!process.env["DEEPGRAM_API_KEY"]?.trim()) missing.push("DEEPGRAM_API_KEY");
  if (!process.env["OPENAI_API_KEY"]?.trim()) missing.push("OPENAI_API_KEY");
  if (!process.env["CARTESIA_API_KEY"]?.trim()) missing.push("CARTESIA_API_KEY");
  return missing;
}

async function resolveKernelOptions(ext: ExtendedRunOneTurnOptions): Promise<HeadlessSessionOptions> {
  if (ext.sessionOverrides !== undefined) return ext.sessionOverrides;

  ensureRepoRootDotenv();
  coerceGoogleGenAiKey();
  const missing = listMissingVoiceHeadlessEnvKeys();
  if (missing.length > 0) throw new Error(`missing live provider env: ${missing.join(", ")}`);

  return {
    plugins: {
      stt: new DeepgramSTTPlugin(),
      vad: new SileroVADPlugin(),
      bridge: new ReasoningBridge(fromStreamText({
        model: createOpenAI({ apiKey: process.env["OPENAI_API_KEY"]! })(ext.model ?? DEFAULT_MODEL),
        system: ext.systemPrompt ?? DEFAULT_SYSTEM_LINES.join("\n"),
        temperature: 0.4,
        maxOutputTokens: 256,
        maxRetries: 0,
        timeout: 30_000,
        stopWhen: stepCountIs(1),
      })),
      tts: new CartesiaTTSPlugin(),
    },
    pluginConfig: {
      stt: {
        api_key: process.env["DEEPGRAM_API_KEY"],
        sample_rate: 16000,
        endpointing: 600,
        model: "nova-3",
        language: "en-US",
      },
      vad: { threshold: 0.01 },
      bridge: {},
      tts: {
        api_key: process.env["CARTESIA_API_KEY"],
        voice_id: ext.voiceId ?? DEFAULT_VOICE_ID,
        model_id: "sonic-3",
        sample_rate: 16000,
        language: "en",
      },
    },
    sttForceFinalizeTimeoutMs: 3500,
  };
}

function callOptionalFrameProcessor(plugin: VoicePlugin | undefined, contextId: string): void {
  const candidate = plugin as { processFrame?: (contextId: string) => void } | undefined;
  candidate?.processFrame?.(contextId);
}

async function callOptionalScriptedStt(plugin: VoicePlugin | undefined, contextId: string): Promise<void> {
  const candidate = plugin as { emitScripted?: (contextId: string) => Promise<void> } | undefined;
  await candidate?.emitScripted?.(contextId);
}

export async function runOneTurn(opts: ExtendedRunOneTurnOptions): Promise<TurnResult> {
  const kernel = await resolveKernelOptions(opts);
  const session = new VoiceAgentSession({
    plugins: kernel.pluginConfig,
    sttForceFinalizeTimeoutMs: kernel.sttForceFinalizeTimeoutMs ?? 3500,
  });
  for (const [name, plugin] of Object.entries(kernel.plugins)) {
    session.registerPlugin(name, plugin);
  }

  return driveTurn({
    session,
    inputWavPath: opts.inputWavPath,
    sessionDir: opts.sessionDir,
    syntheticMono16kSamples: opts.syntheticMono16kSamples,
    realtimePacing: opts.realtimePacing,
    onAudioFrame: (contextId) => callOptionalFrameProcessor(kernel.plugins["vad"], contextId),
    onAudioFed: (contextId) => callOptionalScriptedStt(kernel.plugins["stt"], contextId),
  });
}

export { DEFAULT_VOICE_ID };
