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

// The spoken preamble is load-bearing, not flavour. This fixture exists to prove that a
// slow tool cannot gap audio that is ALREADY FLOWING — so the agent must be speaking when
// the tool blocks. Without the preamble the model calls the tool before it says anything,
// the tool window contains no audio frames at all, and the harness has nothing to measure.
// Same technique the turn-decomposition spike used to move firstLlmDelta off pass-2.
const SLOW_TOOL_PROMPT_LINES = [
  "Your VERY FIRST output on every turn is one short spoken sentence telling the student what you are about to check — for example: \"Let me sync with the registration system and pull up your record.\" Emit that sentence as plain text before any tool call.",
  "Only after that sentence, call registrationSystemSync to sync with the external registration system, and then call studentRelationsLookup for the grounded answer.",
  "Between the two tools, registrationSystemSync always precedes studentRelationsLookup. That ordering is about the tools only — it never overrides the spoken sentence, which always comes before both.",
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

// Defaults match how dev-server constructs the bundled demo agent, so this fixture
// is usable as the zero-arg `--agent <module>#<export>` factory that host expects.
const SLOW_TOOL_SESSION_DEFAULTS: UniversitySupportSlowToolSessionOptions = {
  inputSampleRate: 16000,
  profile: "interactive",
  // On is the closer configuration to a realistic call, but MEASURED CAVEAT: it does not
  // by itself put audio inside the tool window. Across six live runs against a 2006-2008ms
  // tool — default prompt, spoken-preamble prompt, de-conflicted preamble prompt, and this
  // filler enabled — the first audio frame arrived 1.9-4.6s AFTER the tool window closed,
  // and the window held zero frames every time.
  //
  // That is structural, not a tuning failure. On a FIRST-turn tool call the cascade is
  // sequential: STT, then LLM (which blocks in the tool), then TTS. Nothing is speaking
  // yet, so there is no in-flight audio for the media lane to protect. Measuring the
  // inter-frame gap inside the tool window needs a fixture where the tool fires while the
  // assistant is already speaking — a mid-response or multi-turn tool call.
  latencyFillerEnabled: true,
};

export function createUniversitySupportSlowToolSession(
  options: UniversitySupportSlowToolSessionOptions = SLOW_TOOL_SESSION_DEFAULTS,
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
