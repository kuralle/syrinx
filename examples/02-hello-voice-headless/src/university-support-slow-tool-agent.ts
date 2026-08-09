// SPDX-License-Identifier: MIT
//
// University-support agent variant for the media-lane harness: one extra tool whose
// handler performs real HTTP I/O against the local delay server shipped with the harness.

import { createOpenAI } from "@ai-sdk/openai";
import { tool, stepCountIs } from "ai";
import { z } from "zod";

import {
  HedgedReasoner,
  VoiceAgentSession,
  type Reasoner,
  type VoicePlugin,
} from "@kuralle-syrinx/core";
import { ReasoningBridge, fromStreamText } from "@kuralle-syrinx/aisdk";
import { DeepgramSTTPlugin } from "@kuralle-syrinx/deepgram";
import { PipecatEOSPlugin } from "@kuralle-syrinx/pipecat-smart-turn";
import { CartesiaTTSPlugin } from "@kuralle-syrinx/cartesia";
import { GeminiTTSPlugin } from "@kuralle-syrinx/gemini";
import { DeepgramTTSPlugin } from "@kuralle-syrinx/deepgram";
import { SileroVADPlugin } from "@kuralle-syrinx/silero-vad";

import { DEFAULT_MODEL } from "./run-one-turn.js";
import { evaluateUniversitySupportTurn, UniversitySupportObserver } from "./university-support-observer.js";
import {
  UNIVERSITY_SUPPORT_SYSTEM_PROMPT,
  createUniversitySupportPluginConfig,
  studentRelationsTools,
  type UniversitySupportSessionOptions,
  type UniversitySupportTtsProvider,
} from "./university-support-agent.js";

export const SLOW_TOOL_NAME = "registrationSystemSync";

const SLOW_TOOL_PROMPT_LINES = [
  "When a student asks about late add, registration, or course enrollment, you MUST call registrationSystemSync first to sync with the external registration system, then call studentRelationsLookup for the grounded answer.",
  "Always call registrationSystemSync before studentRelationsLookup on the first turn about registration or late add.",
] as const;

export const UNIVERSITY_SUPPORT_SLOW_TOOL_SYSTEM_PROMPT = [
  UNIVERSITY_SUPPORT_SYSTEM_PROMPT,
  ...SLOW_TOOL_PROMPT_LINES,
].join("\n");

function resolveDelayServerUrl(): string {
  const fromEnv = process.env["SYRINX_MEDIA_LANE_DELAY_URL"]?.trim();
  if (fromEnv) return fromEnv;
  throw new Error("SYRINX_MEDIA_LANE_DELAY_URL is required for the slow-tool fixture agent");
}

export function createSlowToolTools(delayServerUrl: string) {
  return {
    ...studentRelationsTools,
    [SLOW_TOOL_NAME]: tool({
      description:
        "Sync with the external university registration system before answering enrollment or late-add questions. Must be called before studentRelationsLookup on registration turns.",
      inputSchema: z.object({
        studentId: z.string().optional(),
        requestType: z.string().describe("Short request type, for example late_add or registration_check."),
      }),
      execute: async ({ studentId, requestType }) => {
        const target = new URL(delayServerUrl);
        if (!target.searchParams.has("ms")) {
          const configured = process.env["SYRINX_MEDIA_LANE_DELAY_MS"]?.trim();
          const delayMs = configured ? Number.parseInt(configured, 10) : 2000;
          if (Number.isFinite(delayMs) && delayMs >= 0) {
            target.searchParams.set("ms", String(delayMs));
          }
        }
        const response = await fetch(target);
        if (!response.ok) {
          throw new Error(`registrationSystemSync failed: ${String(response.status)} ${await response.text()}`);
        }
        const body = (await response.json()) as { ok?: boolean; delayMs?: number };
        return {
          requestType,
          studentId: studentId ?? "S10042",
          synced: body.ok === true,
          delayMs: body.delayMs ?? null,
        };
      },
    }),
  };
}

export interface UniversitySupportSlowToolSessionOptions extends UniversitySupportSessionOptions {
  /** Override delay-server URL (defaults to SYRINX_MEDIA_LANE_DELAY_URL). */
  readonly delayServerUrl?: string;
}

function buildSlowToolReasoner(
  options: UniversitySupportSlowToolSessionOptions,
  delayServerUrl: string,
  interactive: boolean,
): Reasoner {
  const slowTools = createSlowToolTools(delayServerUrl);
  const make = (): Reasoner =>
    fromStreamText({
      model: createOpenAI({ apiKey: requireEnv("OPENAI_API_KEY") })(
        process.env["SYRINX_LLM_MODEL"]?.trim() || DEFAULT_MODEL,
      ),
      system: options.systemPrompt ?? UNIVERSITY_SUPPORT_SLOW_TOOL_SYSTEM_PROMPT,
      tools: slowTools,
      temperature: 0.2,
      maxOutputTokens: interactive ? 1024 : 1400,
      maxRetries: 0,
      timeout: interactive ? 30_000 : 60_000,
      stopWhen: stepCountIs(options.maxSteps ?? 4),
    });

  if (options.hedgeAfterMs === undefined) return make();
  return new HedgedReasoner({
    primary: make(),
    backup: make(),
    hedgeAfterMs: options.hedgeAfterMs,
  });
}

export function createUniversitySupportSlowToolSession(
  options: UniversitySupportSlowToolSessionOptions,
): VoiceAgentSession {
  const delayServerUrl = options.delayServerUrl ?? resolveDelayServerUrl();
  const ttsProvider = options.ttsProvider ?? inferTtsProvider();
  const interactive = options.profile === "interactive";
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
    ...(options.metricsExporter ? { metricsExporter: options.metricsExporter } : {}),
  });

  const plugins: Record<string, VoicePlugin> = {
    stt: new DeepgramSTTPlugin(),
    vad: new SileroVADPlugin(),
    eos: new PipecatEOSPlugin(),
    bridge: new ReasoningBridge(buildSlowToolReasoner(options, delayServerUrl, interactive), {
      speculative: options.speculative === true,
    }),
    observer: new UniversitySupportObserver(evaluateUniversitySupportTurn),
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
