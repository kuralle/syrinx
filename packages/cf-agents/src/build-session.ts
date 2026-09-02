// SPDX-License-Identifier: MIT

import {
  VoiceAgentSession,
  type IdleTimeoutConfig,
  type Reasoner,
  type ReasonerMessage,
  type ReasonerSessionStore,
  type VoicePlugin,
  type PluginConfig,
} from "@kuralle-syrinx/core";
import { RealtimeBridge, type RealtimeAdapter } from "@kuralle-syrinx/realtime";
import { ReasoningBridge } from "@kuralle-syrinx/aisdk";

/** Per-session context handed to every pipeline factory. */
export interface VoicePipelineContext {
  readonly sessionId: string;
  /**
   * G4 resume state for the session, present when durable history is on. The
   * `realtime()` factory wires it into the adapter: `resumeHistory: ctx.resume.history`
   * on replay providers (OpenAI), `sessionResumptionHandle: ctx.resume.providerHandle`
   * on native-resume providers (Gemini — do NOT also replay, R6).
   */
  readonly resume?: {
    /** Live view of the durable transcript (call again on reconnect for the current state). */
    readonly history: () => readonly { readonly role: "user" | "assistant"; readonly content: string }[];
    /** Latest provider-native resume handle, when one was issued. */
    readonly providerHandle?: string;
  };
}

/** Host wiring (withVoice) threaded into the assembled session. */
export interface VoiceSessionWiring {
  /** G4: durable store for the cascaded ReasoningBridge's conversation history. */
  readonly reasonerSessionStore?: ReasonerSessionStore;
  /** G4: prior-context provider for realtime delegate turns (live view of durable history). */
  readonly contextProvider?: () => readonly ReasonerMessage[];
  /** G3: ms before a pending tool call fires its "delayed" (still-working) cue. */
  readonly delayCueAfterMs?: number;
  /**
   * Idle-timeout override. Defaults to the 15s telephony re-engagement. Browser/edge
   * hosts pass `{ durationMs: 0 }` to disable it — a playground/demo user granting mic
   * or reading the UI should never be nagged ("Are you still there?") or disconnected.
   */
  readonly idleTimeout?: Partial<IdleTimeoutConfig>;
}

/** A cascaded-stage plugin plus its `VoiceAgentSession` plugin config. */
export interface CascadedStage {
  readonly plugin: VoicePlugin;
  readonly config?: PluginConfig;
}

export type CascadedEndpointingOwner = "provider_stt" | "smart_turn";

/**
 * Peer fields describing the voice shape. Populate `realtime` for a realtime front,
 * `stt` + `tts` for a cascade, or `realtime` + `tts` for a half-cascade (a text-only
 * realtime front paired with a local TTS plugin). The shape is derived from which
 * fields are populated (see `resolveVoiceShape`), never selected via a mode literal.
 */
export interface VoicePipelineFields<Env> {
  /** Realtime (speech-to-speech) front. Present ⇒ the front owns input; with `tts` ⇒ half-cascade. */
  readonly realtime?: (env: Env, ctx: VoicePipelineContext) => RealtimeAdapter;
  readonly stt?: (env: Env, ctx: VoicePipelineContext) => CascadedStage;
  readonly tts?: (env: Env, ctx: VoicePipelineContext) => CascadedStage;
  readonly vad?: (env: Env, ctx: VoicePipelineContext) => CascadedStage;
  /** Optional EOS stage. Returning `undefined` is equivalent to omitting the stage. */
  readonly eos?: (env: Env, ctx: VoicePipelineContext) => CascadedStage | undefined;
  /** Name of the front-model tool routed to the reasoner. @default "consult_knowledge" */
  readonly delegateToolName?: string;
  /**
   * How the delegate answer reaches the front model (G1): `"envelope"` (default) wraps
   * it as a `DelegateResultEnvelope` (`response_text` + `require_repeat_verbatim`);
   * `"string"` injects the raw answer.
   */
  readonly toolResultFormat?: "envelope" | "string";
  /** Optional `render` directive included in the envelope, e.g. `"translate_faithfully"`. */
  readonly renderDirective?: string;
  /**
   * Which component owns end-of-speech. @default "provider_stt". Set to
   * "smart_turn" when supplying an `eos` stage. May be a static literal or an
   * `(env) => owner` factory for per-request selection (e.g. smart_turn only
   * when Workers AI is bound).
   */
  readonly endpointingOwner?: CascadedEndpointingOwner | ((env: Env) => CascadedEndpointingOwner);
  /**
   * Fallback timeout (ms) before the engine force-finalizes a turn when the STT provider's own
   * endpointing/finalize never fires. Maps to `VoiceAgentSession`'s `sttForceFinalizeTimeoutMs`
   * (engine default 7000). Set it when a provider-endpointed cascade tunes this (e.g. Deepgram at 3500).
   */
  readonly sttForceFinalizeTimeoutMs?: number;
  /**
   * Speculative generation: start the reasoner on an eager end-of-turn signal
   * (`eos.interim` — Deepgram Flux `eager_eot_threshold`, smart-turn interim) and
   * commit/discard when the endpoint confirms. Trades extra LLM calls for
   * parallelizing LLM TTFT with endpoint confirmation. @default false
   */
  readonly speculative?: boolean;
}

export type VoiceShape = "realtime" | "half_cascade" | "cascade";

/**
 * Derives the voice shape from which peer fields are populated (ADR 0007 — behaviour
 * follows populated fields, never a mode selector). `realtime` alone is a realtime
 * front; `realtime` + `tts` is a half-cascade (text-only front, local TTS); `stt` +
 * `tts` is a cascade. Any other combination is a contradiction or an omission and
 * throws, naming exactly the field at fault.
 */
const CASCADE_ONLY_FIELDS = ["vad", "eos", "endpointingOwner", "sttForceFinalizeTimeoutMs", "speculative"] as const;
const REALTIME_ONLY_FIELDS = ["delegateToolName", "toolResultFormat", "renderDirective"] as const;

function rejectFieldsForeignToShape<Env>(
  fields: VoicePipelineFields<Env>,
  shape: VoiceShape,
): void {
  const foreign = shape === "cascade" ? REALTIME_ONLY_FIELDS : CASCADE_ONLY_FIELDS;
  const present = foreign.filter((name) => fields[name] !== undefined);
  if (present.length === 0) return;
  const owner = shape === "cascade" ? "a `realtime` front" : "a cascade (`stt` + `tts`)";
  throw new Error(
    `withVoice: \`${present.join("`, `")}\` only applies to ${owner}; remove it from this ${shape.replace("_", "-")} configuration`,
  );
}

export function resolveVoiceShape<Env>(fields: VoicePipelineFields<Env>): VoiceShape {
  const hasRealtime = fields.realtime !== undefined;
  const hasStt = fields.stt !== undefined;
  const hasTts = fields.tts !== undefined;

  let shape: VoiceShape;
  if (hasRealtime) {
    if (hasStt) throw new Error("withVoice: `realtime` owns input; remove `stt`");
    shape = hasTts ? "half_cascade" : "realtime";
  } else if (hasStt && hasTts) {
    shape = "cascade";
  } else if (hasStt || hasTts) {
    throw new Error(`withVoice: a cascade needs both \`stt\` and \`tts\`; got ${hasStt ? "stt" : "tts"} only`);
  } else {
    throw new Error("withVoice: provide `realtime`, or `stt` + `tts`");
  }
  rejectFieldsForeignToShape(fields, shape);
  return shape;
}

/**
 * Assemble a `VoiceAgentSession` for the configured voice shape. This is the single
 * place that maps the peer-field config onto Syrinx's plugin slots, so the realtime,
 * half-cascade, and cascade shapes stay first-class instead of mode-flagged.
 */
export function buildVoiceSession<Env>(
  fields: VoicePipelineFields<Env>,
  env: Env,
  reasoner: Reasoner | undefined,
  ctx: VoicePipelineContext,
  wiring: VoiceSessionWiring = {},
): VoiceAgentSession {
  const shape = resolveVoiceShape(fields);

  if (shape === "realtime") {
    const front = fields.realtime!(env, ctx);
    const bridge = new RealtimeBridge(front, reasoner, fields.delegateToolName, {
      ...(fields.toolResultFormat !== undefined ? { toolResultFormat: fields.toolResultFormat } : {}),
      ...(fields.renderDirective !== undefined ? { renderDirective: fields.renderDirective } : {}),
      ...(wiring.contextProvider ? { contextProvider: wiring.contextProvider } : {}),
    });
    const session = new VoiceAgentSession({
      plugins: { realtime: {} },
      endpointingOwner: "timer",
      ...(wiring.delayCueAfterMs !== undefined ? { delayCueAfterMs: wiring.delayCueAfterMs } : {}),
      ...(wiring.idleTimeout !== undefined ? { idleTimeout: wiring.idleTimeout } : {}),
    });
    session.registerPlugin("realtime", bridge);
    return session;
  }

  if (shape === "half_cascade") {
    const front = fields.realtime!(env, ctx);
    const tts = fields.tts!(env, ctx);
    const bridge = new RealtimeBridge(front, reasoner, fields.delegateToolName, {
      textOnly: true,
      ...(fields.toolResultFormat !== undefined ? { toolResultFormat: fields.toolResultFormat } : {}),
      ...(fields.renderDirective !== undefined ? { renderDirective: fields.renderDirective } : {}),
      ...(wiring.contextProvider ? { contextProvider: wiring.contextProvider } : {}),
    });
    const session = new VoiceAgentSession({
      plugins: { realtime: {}, tts: tts.config ?? {} },
      endpointingOwner: "timer",
      ...(wiring.delayCueAfterMs !== undefined ? { delayCueAfterMs: wiring.delayCueAfterMs } : {}),
      ...(wiring.idleTimeout !== undefined ? { idleTimeout: wiring.idleTimeout } : {}),
    });
    session.registerPlugin("realtime", bridge);
    session.registerPlugin("tts", tts.plugin);
    return session;
  }

  if (!reasoner) {
    throw new Error(
      "withVoice: a cascaded pipeline needs a reasoner. Set `reasoner` in the options, " +
        "or expose a kuralle `runtime` on the Agent so it defaults to fromKuralleRuntime(this.runtime).",
    );
  }

  const stt = fields.stt!(env, ctx);
  const tts = fields.tts!(env, ctx);
  const vad = fields.vad?.(env, ctx);
  const eos = fields.eos?.(env, ctx);
  const endpointingOwner =
    typeof fields.endpointingOwner === "function"
      ? fields.endpointingOwner(env)
      : fields.endpointingOwner;

  if (endpointingOwner === "smart_turn" && !eos) {
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
    endpointingOwner: endpointingOwner ?? "provider_stt",
    ...(fields.sttForceFinalizeTimeoutMs !== undefined
      ? { sttForceFinalizeTimeoutMs: fields.sttForceFinalizeTimeoutMs }
      : {}),
    ...(wiring.delayCueAfterMs !== undefined ? { delayCueAfterMs: wiring.delayCueAfterMs } : {}),
    ...(wiring.idleTimeout !== undefined ? { idleTimeout: wiring.idleTimeout } : {}),
  });
  session.registerPlugin("stt", stt.plugin);
  session.registerPlugin(
    "bridge",
    new ReasoningBridge(reasoner, {
      ...(wiring.reasonerSessionStore
        ? { sessionStore: wiring.reasonerSessionStore, sessionId: ctx.sessionId }
        : {}),
      ...(fields.speculative ? { speculative: true } : {}),
    }),
  );
  session.registerPlugin("tts", tts.plugin);
  if (vad) session.registerPlugin("vad", vad.plugin);
  if (eos) session.registerPlugin("eos", eos.plugin);
  return session;
}
