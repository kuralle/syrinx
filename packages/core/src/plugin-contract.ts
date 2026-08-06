// SPDX-License-Identifier: MIT
//
// Syrinx Kernel v2 — Plugin Contract
//
// Every pipeline plugin (STT, TTS, VAD, EOS, Denoiser, Bridge) implements
// this interface. Plugins receive the PipelineBus on initialization and
// push all output (transcripts, audio, errors, events) into the bus.
//
// Breaking change from v0.1: plugins now accept PipelineBus directly.
// No callbacks, no adapters. Clean contract, one code path.

import type { PipelineBus } from "./pipeline-bus.js";

// =============================================================================
// Contract
// =============================================================================

export type EndpointingOwner = "provider_stt" | "smart_turn";

export interface EndpointingCapability {
  readonly owner: EndpointingOwner;
  readonly disableConfig?: PluginConfig;
}

/**
 * Vendor-agnostic mid-stream STT reconfiguration. Per-turn reconfigure is a COMMODITY STT capability
 * (Deepgram Flux `Configure`, AssemblyAI `UpdateConfiguration`, Speechmatics `SetRecognitionConfig`) —
 * the value of THIS seam is normalizing those differing wire shapes behind one interface so an
 * InteractionPolicy can actuate any STT without vendor-specific plumbing. All fields optional; a plugin
 * applies what it supports and ignores the rest (best-effort — e.g. Deepgram ignores `contextText`).
 */
export interface SttReconfigurePartial {
  readonly keyterms?: readonly string[];
  readonly eotThreshold?: number;
  readonly eagerEotThreshold?: number;
  readonly eotTimeoutMs?: number;
  /** Silence-based endpointing (ms). Nova-style; Flux may ignore (it uses eotTimeoutMs). */
  readonly endpointingMs?: number;
  readonly vadThreshold?: number;
  readonly languageHints?: readonly string[];
  /**
   * Hard recognition-language switch (e.g. "en-US" → "es-ES", or Nova-3 "multi" for code-switch).
   * Distinct from `languageHints` (soft bias): this changes the recognizer's language. Providers
   * that carry language in the connection URL (Nova) reconnect to apply it; model-fixed providers
   * (Flux, `flux-general-en`) ignore it and rely on `languageHints`.
   */
  readonly language?: string;
  /** AssemblyAI-style agent-context biasing (the agent's own prior reply). Ignored where unsupported. */
  readonly contextText?: string;
}

export interface SttReconfigure {
  reconfigure(partial: SttReconfigurePartial): void;
}

export interface VoicePlugin {
  readonly endpointingCapability?: EndpointingCapability;

  /** Present when the STT supports mid-stream reconfiguration (see {@link SttReconfigure}). */
  readonly sttReconfigure?: SttReconfigure;

  /**
   * Receive the session-owned IU ledger before initialize when this plugin segments or
   * consumes turns (e.g. ReasoningBridge). Optional — plugins that omit it keep a private ledger.
   */
  bindIuLedger?(ledger: import("./iu-ledger.js").IuLedger): void;

  /**
   * Initialize the plugin. Called during the init chain.
   * Connect to provider, start streams, register bus handlers if needed.
   *
   * @param bus — The session's PipelineBus. Push all output packets here.
   * @param config — Plugin-specific configuration (API keys, model IDs, etc.).
   */
  initialize(bus: PipelineBus, config: PluginConfig): Promise<void>;

  /**
   * Best-effort warm of remote/expensive resources (open connections, wake a scaled-to-zero
   * endpoint). Called AFTER initialize, before the first turn. Must not throw fatally — swallow
   * errors internally. Optional; plugins with nothing to warm omit it.
   */
  prewarm?(): Promise<void>;

  /**
   * Tear down the plugin. Called during the finalize chain (reverse order).
   * Close connections, flush buffers, release resources.
   */
  close(): Promise<void>;
}

// =============================================================================
// Configuration
// =============================================================================

/**
 * Plugin configuration — a flat key-value bag.
 * Plugins extract the keys they need (e.g., "api_key", "model_id", "voice_id").
 */
export type PluginConfig = Record<string, unknown>;

/**
 * Convenience: extract a string config value, throwing if missing.
 */
export function requireStringConfig(
  config: PluginConfig,
  key: string,
): string {
  const value = config[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Plugin config missing required key: ${key}`);
  }
  return value;
}

/**
 * Convenience: extract an optional string config value.
 */
export function optionalStringConfig(
  config: PluginConfig,
  key: string,
): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}
