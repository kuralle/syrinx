// SPDX-License-Identifier: MIT

import {
  VoiceAgentSession,
  type Reasoner,
  type VoicePlugin,
  type PluginConfig,
} from "@kuralle-syrinx/core";
import { RealtimeBridge, type RealtimeAdapter } from "@kuralle-syrinx/realtime";
import { ReasoningBridge } from "@kuralle-syrinx/aisdk";

/** Per-session context handed to every pipeline factory. */
export interface VoicePipelineContext {
  readonly sessionId: string;
}

/**
 * Realtime front pipeline: a single speech-to-speech model (Gemini Live,
 * OpenAI Realtime, …) owns STT+TTS+turn-taking; the reasoner is consulted via a
 * front-model delegate tool. Assembled exactly as the verified realtime path:
 * `plugins: { realtime: {} }`, `endpointingOwner: "timer"`.
 */
export interface RealtimePipeline<Env> {
  readonly kind: "realtime";
  /** The realtime front adapter, e.g. `fromGeminiLive(...)` / `fromOpenAIRealtime(...)`. */
  readonly front: (env: Env, ctx: VoicePipelineContext) => RealtimeAdapter;
  /** Name of the front-model tool routed to the reasoner. @default "consult_knowledge" */
  readonly delegateToolName?: string;
}

/** A cascaded-stage plugin plus its `VoiceAgentSession` plugin config. */
export interface CascadedStage {
  readonly plugin: VoicePlugin;
  readonly config?: PluginConfig;
}

/**
 * Cascaded pipeline: discrete STT → reasoner → TTS stages (optionally VAD + a
 * Smart-Turn EOS). Assembled exactly as the verified cascaded path:
 * `plugins: { stt, vad?, eos?, bridge, tts }`, reasoner wrapped in a
 * `ReasoningBridge` registered as `"bridge"`.
 */
export interface CascadedPipeline<Env> {
  readonly kind: "cascaded";
  readonly stt: (env: Env, ctx: VoicePipelineContext) => CascadedStage;
  readonly tts: (env: Env, ctx: VoicePipelineContext) => CascadedStage;
  readonly vad?: (env: Env, ctx: VoicePipelineContext) => CascadedStage;
  readonly eos?: (env: Env, ctx: VoicePipelineContext) => CascadedStage;
  /**
   * Which component owns end-of-speech. @default "provider_stt". Set to
   * "smart_turn" when supplying an `eos` stage.
   */
  readonly endpointingOwner?: "provider_stt" | "smart_turn";
  /**
   * Fallback timeout (ms) before the engine force-finalizes a turn when the STT provider's own
   * endpointing/finalize never fires. Maps to `VoiceAgentSession`'s `sttForceFinalizeTimeoutMs`
   * (engine default 7000). Set it when a provider-endpointed cascade tunes this (e.g. Deepgram at 3500).
   */
  readonly sttForceFinalizeTimeoutMs?: number;
}

export type VoicePipeline<Env> = RealtimePipeline<Env> | CascadedPipeline<Env>;

/**
 * Assemble a `VoiceAgentSession` for the configured pipeline. This is the single
 * place that maps the high-level pipeline config onto Syrinx's plugin slots, so
 * the realtime and cascaded shapes stay first-class instead of mode-flagged.
 */
export function buildVoiceSession<Env>(
  pipeline: VoicePipeline<Env>,
  env: Env,
  reasoner: Reasoner | undefined,
  ctx: VoicePipelineContext,
): VoiceAgentSession {
  if (pipeline.kind === "realtime") {
    const front = pipeline.front(env, ctx);
    const bridge = new RealtimeBridge(front, reasoner, pipeline.delegateToolName);
    const session = new VoiceAgentSession({
      plugins: { realtime: {} },
      endpointingOwner: "timer",
    });
    session.registerPlugin("realtime", bridge);
    return session;
  }

  if (!reasoner) {
    throw new Error(
      "withVoice: a cascaded pipeline needs a reasoner. Set `reasoner` in the options, " +
        "or expose a kuralle `runtime` on the Agent so it defaults to fromKuralleRuntime(this.runtime).",
    );
  }

  const stt = pipeline.stt(env, ctx);
  const tts = pipeline.tts(env, ctx);
  const vad = pipeline.vad?.(env, ctx);
  const eos = pipeline.eos?.(env, ctx);

  if (pipeline.endpointingOwner === "smart_turn" && !eos) {
    throw new Error(
      'withVoice: a cascaded pipeline with endpointingOwner "smart_turn" must provide an `eos` stage ' +
        "(e.g. a PipecatEOSPlugin); otherwise no component owns end-of-speech and turns never complete.",
    );
  }

  const plugins: Record<string, PluginConfig> = {
    stt: stt.config ?? {},
    bridge: {},
    tts: tts.config ?? {},
  };
  if (vad) plugins["vad"] = vad.config ?? {};
  if (eos) plugins["eos"] = eos.config ?? {};

  const session = new VoiceAgentSession({
    plugins,
    endpointingOwner: pipeline.endpointingOwner ?? "provider_stt",
    ...(pipeline.sttForceFinalizeTimeoutMs !== undefined
      ? { sttForceFinalizeTimeoutMs: pipeline.sttForceFinalizeTimeoutMs }
      : {}),
  });
  session.registerPlugin("stt", stt.plugin);
  session.registerPlugin("bridge", new ReasoningBridge(reasoner));
  session.registerPlugin("tts", tts.plugin);
  if (vad) session.registerPlugin("vad", vad.plugin);
  if (eos) session.registerPlugin("eos", eos.plugin);
  return session;
}
