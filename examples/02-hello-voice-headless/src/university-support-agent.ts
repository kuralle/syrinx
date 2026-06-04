// SPDX-License-Identifier: MIT

import { tool } from "ai";
import { z } from "zod";

import { VoiceAgentSession, type PluginConfig, type VoicePlugin } from "@asyncdot/voice";
import { AISDKBridgePlugin } from "@asyncdot/voice-bridge-aisdk";
import { DeepgramSTTPlugin } from "@asyncdot/voice-stt-deepgram";
import { PipecatEOSPlugin } from "@asyncdot/voice-turn-pipecat";
import { CartesiaTTSPlugin } from "@asyncdot/voice-tts-cartesia";
import { GeminiTTSPlugin } from "@asyncdot/voice-tts-gemini";
import { DeepgramTTSPlugin } from "@asyncdot/voice-tts-deepgram";
import { SileroVADPlugin } from "@asyncdot/voice-vad-silero";

import { DEFAULT_MODEL } from "./run-one-turn.js";

export const UNIVERSITY_SUPPORT_SYSTEM_PROMPT = [
  "You are Syrinx University's Student Relations voice agent.",
  "This is one ongoing phone conversation. Use the previous turns for references like it, that, the case, or the petition.",
  "Call studentRelationsLookup before answering student-services requests when the answer depends on student records, deadlines, holds, offices, fees, appointments, or case status.",
  "Never invent deadlines, approvals, holds, fees, visa guidance, accommodations, appointments, or case status.",
  "For voice, answer in two concise complete sentences. Confirm the action first, then mention the constraint or next owner.",
  "Never end with an incomplete sentence or phrase. Every answer must end with punctuation.",
].join("\n");

export const studentRelationsTools = {
  studentRelationsLookup: tool({
    description:
      "Lookup Student Relations data for a student's registration, late-add, holds, aid, housing, visa, accessibility, athletics, fee, case, appointment, or summary request.",
    inputSchema: z.object({
      studentId: z.string().optional(),
      name: z.string().optional(),
      requestType: z.string().describe("Short request type, for example late_add, holds, aid, visa, case, appointment."),
      courseCode: z.string().optional(),
      summary: z.string().optional(),
    }),
    execute: async ({ studentId, name, requestType, courseCode, summary }) => ({
      requestType,
      summary,
      student: {
        studentId: studentId ?? "S10042",
        name: name ?? "Maya Chen",
        academicStanding: "good",
        activeHolds: [],
        advisor: "Dr. Priya Raman",
        backupAdvisor: "Student Relations advising desk",
        internationalOfficeRequired: true,
        athleticsCoordinator: "Jordan Lee",
      },
      registration: {
        courseCode: courseCode ?? "Biology 101",
        term: "Spring 2027",
        addDeadline: "2027-02-05",
        currentDate: "2027-02-09",
        status: "late_add_required",
        form: "Late Add Petition",
        approvals: ["course instructor", "academic advisor or advising desk", "registrar"],
        portal: "Student Relations portal",
        labFee: "$85 biology lab fee, posted after registrar processing",
      },
      relatedOffices: {
        financialAid: "Full-time status review is Friday at 5 PM.",
        internationalOffice: "Notify International Student Services while the petition is pending.",
        housing: "Use pending late-add case number on the renewal form.",
        accessibility: "Accessibility office should review lab-time accommodation before registrar processing.",
        athletics: "Athletics academic coordinator can be added as a case watcher.",
      },
      case: {
        caseId: "SR-2027-004812",
        status: "open",
        nextSteps: [
          "Upload instructor email and department lab-seat confirmation.",
          "Route the Late Add Petition to the instructor, advising desk, and registrar.",
          "Notify International Student Services and Financial Aid today.",
          "Add accessibility and athletics notes as case watchers.",
        ],
        appointment: "Video appointment available tomorrow at 2:45 PM.",
      },
    }),
  }),
};

export type UniversitySupportProfile = "interactive" | "longform";
export type UniversitySupportTtsProvider = "cartesia" | "gemini" | "deepgram";

export interface UniversitySupportSessionOptions {
  readonly inputSampleRate: number;
  readonly profile: UniversitySupportProfile;
  readonly ttsProvider?: UniversitySupportTtsProvider;
  readonly latencyFillerEnabled?: boolean;
}

export function createUniversitySupportSession(options: UniversitySupportSessionOptions): VoiceAgentSession {
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

  const plugins: Record<string, VoicePlugin> = {
    stt: new DeepgramSTTPlugin(),
    vad: new SileroVADPlugin(),
    eos: new PipecatEOSPlugin(),
    bridge: new AISDKBridgePlugin(),
    tts: createTtsPlugin(ttsProvider),
  };
  for (const [name, plugin] of Object.entries(plugins)) {
    session.registerPlugin(name, plugin);
  }
  return session;
}

export function createUniversitySupportPluginConfig(
  options: UniversitySupportSessionOptions & { readonly ttsProvider?: UniversitySupportTtsProvider },
): Record<string, PluginConfig> {
  const interactive = options.profile === "interactive";
  const ttsProvider = options.ttsProvider ?? inferTtsProvider();
  return {
    stt: {
      api_key: requireEnv("DEEPGRAM_API_KEY"),
      sample_rate: options.inputSampleRate,
      endpointing: interactive ? 700 : 1200,
      model: process.env["SYRINX_DEEPGRAM_MODEL"]?.trim() || "nova-3",
      language: process.env["SYRINX_DEEPGRAM_LANGUAGE"]?.trim() || "en-US",
      smart_format: true,
      finalize_on_speech_final: false,
      emit_eos_on_final: false,
      provider_finalize_timeout_ms: interactive ? 3000 : 1500,
      // Live conversation: if the provider never confirms the Finalize, reply on the
      // buffered transcript instead of dropping the caller's turn.
      finalize_timeout_fallback: true,
    },
    vad: {
      sample_rate: options.inputSampleRate,
      threshold: interactive ? 0.5 : 0.45,
      min_silence_duration_ms: interactive ? 650 : 1400,
      speech_pad_ms: interactive ? 180 : 400,
    },
    eos: {
      finalize_delay_ms: interactive ? 450 : 500,
      max_delay_ms: interactive ? 4500 : 15_000,
      incomplete_fallback_ms: interactive ? 3200 : 1200,
      semantic_shortcut_delay_ms: interactive ? 0 : 50,
      semantic_defer_fallback_ms: interactive ? 4500 : 4000,
    },
    bridge: {
      api_key: requireEnv("GOOGLE_GENERATIVE_AI_API_KEY"),
      model: process.env["SYRINX_LLM_MODEL"]?.trim() || DEFAULT_MODEL,
      system_prompt: UNIVERSITY_SUPPORT_SYSTEM_PROMPT,
      tools: studentRelationsTools,
      temperature: 0.2,
      max_output_tokens: interactive ? 1024 : 1400,
      max_steps: 3,
      max_history_turns: 20,
      timeout_ms: interactive ? 30_000 : 60_000,
    },
    tts:
      ttsProvider === "cartesia"
        ? cartesiaTtsConfig()
        : ttsProvider === "deepgram"
          ? deepgramTtsConfig()
          : geminiTtsConfig(interactive),
  };
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

function deepgramTtsConfig(): PluginConfig {
  return {
    api_key: requireEnv("DEEPGRAM_API_KEY"),
    model: process.env["SYRINX_DEEPGRAM_TTS_MODEL"]?.trim() || "aura-2-thalia-en",
    sample_rate: 24000,
    retry_max_attempts: 2,
  };
}

function cartesiaTtsConfig(): PluginConfig {
  return {
    api_key: requireEnv("CARTESIA_API_KEY"),
    voice_id: process.env["CARTESIA_VOICE_ID"]?.trim() || "694f9389-aac1-45b6-b726-9d9369183238",
    model_id: process.env["SYRINX_CARTESIA_MODEL_ID"]?.trim() || "sonic-3",
    sample_rate: 16000,
    language: "en",
    retry_max_attempts: 2,
  };
}

function geminiTtsConfig(interactive: boolean): PluginConfig {
  return {
    api_key: requireEnv("GOOGLE_GENERATIVE_AI_API_KEY"),
    model: process.env["SYRINX_GEMINI_TTS_MODEL"]?.trim() || "gemini-3.1-flash-tts-preview",
    voice_name: process.env["SYRINX_GEMINI_TTS_VOICE"]?.trim() || "Kore",
    retry_max_attempts: interactive ? 2 : 4,
    retry_base_delay_ms: 500,
    retry_max_delay_ms: 4000,
    timeout_ms: interactive ? 30_000 : 45_000,
  };
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
